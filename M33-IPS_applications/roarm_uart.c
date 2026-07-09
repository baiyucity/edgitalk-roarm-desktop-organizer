#include <rtthread.h>
#include <rtdevice.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>

#ifdef BSP_USING_IPC
#include "drv_ipc.h"
#endif

#include "roarm_uart.h"
#include "soft_uart_tx.h"

/*
 * Edgi-Talk M33 -> RoArm bridge, coordinate-conversion V2.4.
 *
 * Hardware link kept from the stable soft-TX version:
 *   - RoArm TX -> M33 UART5_RX -> forwarded to M55 console.
 *   - M33 TX  -> RoArm A_C2/GPIO35 through GPIO software UART TX.
 *
 * New in V2.0:
 *   - M55 can release torque and manually anchor 4 camera-boundary points.
 *   - M33 records RoArm returned coordinates from {"T":105} / T=1051.
 *   - Image coordinate -> arm coordinate uses bilinear 4-corner mapping.
 *   - Z desk height is the average of the four recorded Z values.
 *   - grab_start enables real T=130 pick commands.
 *
 * New in V2.1:
 *   - armcal_exit records an off-camera exit coordinate.
 *   - after a successful T=130 pick ack, M33 moves RoArm to that exit point if set.
 *   - arm_light sends T=114 to turn on the RoArm head light.
 *
 * New in V2.2:
 *   - arm_light_off sends T=114 led=0.
 *   - armcal_stop turns torque back on and leaves saved 4-corner calibration intact.
 *   - armcal_exit_clear clears the saved off-camera exit point.
 *
 * New in V2.4:
 *   - one M55 coordinate triggers only one pick sequence.
 *   - M33 ignores new coordinates while pick/place/exit is still busy.
 *   - minimum accepted pick interval is 14s to match M55 pacing.
 */

#define ROARM_UART_NAME              "uart5"       /* Hardware RX is still UART5_RX. */
#define ROARM_UART_BAUD              BAUD_RATE_115200

/* 1 = use GPIO software TX for M33 -> RoArm; 0 = fall back to hardware UART5 TX. */
#define ROARM_USE_SOFT_UART_TX       1

#define ROARM_BOOT_QUERY_ENABLE      0
#define ROARM_BOOT_QUERY_DELAY_MS    2500U

/* Avoid repeatedly sending multiple pick-at commands while the same object stays in view. */
#define ROARM_MIN_SEND_INTERVAL_MS   14000U
#define ROARM_ACTION_BUSY_TIMEOUT_MS  22000U

#define ROARM_UART_RX_THREAD_STACK   2048U
#define ROARM_UART_RX_THREAD_PRIO    19U
#define ROARM_UART_RX_THREAD_TICK    10U

#define ROARM_BOOT_THREAD_STACK      1536U
#define ROARM_BOOT_THREAD_PRIO       20U
#define ROARM_BOOT_THREAD_TICK       10U

#define VISION_IPC_MSG_ROARM_RX      0x5503U
#define VISION_IPC_MSG_ROARM_TX      0x5504U

#define ROARM_PICK_CMD_T             130
#define ROARM_PICK_ACK_T             1301
#define ROARM_PLACE_CMD_T            131
#define ROARM_PLACE_ACK_T            1311
#define ROARM_MOVE_XYZT_CMD_T        104
#define ROARM_LIGHT_CMD_T            114
#define ROARM_TORQUE_CMD_T           210
#define ROARM_HOME_CMD_T             102

/* M55 detector coordinates are normalized by uvc_ai.c into this 320x320 AI space. */
#define VISION_COORD_W               320
#define VISION_COORD_H               320
#define VISION_COORD_X_MAX           (VISION_COORD_W - 1)
#define VISION_COORD_Y_MAX           (VISION_COORD_H - 1)

#define ROARM_LINE_BUF_SIZE          192U
#define ROARM_TX_BUF_SIZE            192U
#define IPC_TEXT_CHUNK_BYTES         10U
#define ROARM_DEBUG_BUF_SIZE         256U

/* If RoArm emits a partial line without newline, still forward it after this timeout. */
#define ROARM_RX_PARTIAL_FLUSH_MS    250U

/* Grasp parameters. Place/drop will be added in the next major version. */
#define ROARM_PICK_SPEED_STR         "0.25"
#define ROARM_PLACE_SPEED_STR        "0.25"
#define ROARM_EXIT_SPEED_STR         "0.25"
#define ROARM_EXIT_DEFAULT_T_STR     "3.14"
#define ROARM_LIGHT_PWM              255
#define ROARM_PICK_APPROACH_MM       70
#define ROARM_PICK_LIFT_MM           90
#define ROARM_PLACE_APPROACH_MM      70
#define ROARM_PLACE_LIFT_MM          90
#define ROARM_GRIPPER_OPEN_STR       "2.78"
#define ROARM_GRIPPER_CLOSE_STR      "3.14"
#define ROARM_PLACE_CATEGORY_COUNT   8U

typedef struct
{
    rt_uint8_t valid;
    int32_t x10;
    int32_t y10;
    int32_t z10;
    int32_t t10;
} roarm_cal_point_t;

static rt_device_t g_roarm_uart = RT_NULL;
static rt_thread_t g_roarm_rx_tid = RT_NULL;
static rt_thread_t g_roarm_boot_tid = RT_NULL;
static rt_tick_t g_last_roarm_send_tick = 0;
static rt_uint8_t g_uart_open_reported_ok = 0;
static rt_uint8_t g_uart_open_reported_fail = 0;
static rt_mutex_t g_uart_tx_mutex = RT_NULL;

static roarm_cal_point_t g_cal_points[ROARM_CAL_CORNER_COUNT];
static roarm_cal_point_t g_exit_point;
static roarm_cal_point_t g_place_points[ROARM_PLACE_CATEGORY_COUNT];
static rt_uint8_t g_calibrated = 0U;
static int32_t g_desk_z10 = 0;
static int g_pending_corner = -1;
static rt_tick_t g_pending_corner_tick = 0;
static rt_uint8_t g_grab_enabled = 0U;
static rt_uint8_t g_exit_after_pick_pending = 0U;
static rt_uint8_t g_place_after_pick_pending = 0U;
static rt_uint8_t g_exit_after_place_pending = 0U;
static rt_uint8_t g_last_pick_category = 0U;
static rt_uint8_t g_roarm_action_busy = 0U;
static rt_tick_t g_roarm_action_busy_tick = 0;
static rt_uint32_t g_roarm_action_seq = 0U;

#define ROARM_PENDING_NONE           (-1)
#define ROARM_PENDING_EXIT           (-2)
#define ROARM_PENDING_PLACE_BASE     (-100)

#ifdef BSP_USING_IPC
static rt_device_t g_ipc_dev = RT_NULL;
static rt_uint32_t g_ipc_text_seq = 0;
#endif

static rt_tick_t roarm_ms_to_tick(rt_uint32_t ms)
{
    rt_tick_t ticks = (rt_tick_t)((ms * RT_TICK_PER_SECOND) / 1000U);
    return (ticks == 0U) ? 1U : ticks;
}

static int32_t clamp_i32(int32_t v, int32_t min_v, int32_t max_v)
{
    if (v < min_v) return min_v;
    if (v > max_v) return max_v;
    return v;
}

static int32_t abs_i32(int32_t v)
{
    return (v < 0) ? -v : v;
}

static const char *roarm_corner_name(int corner)
{
    switch (corner)
    {
    case ROARM_CAL_CORNER_TL: return "TL";
    case ROARM_CAL_CORNER_TR: return "TR";
    case ROARM_CAL_CORNER_BL: return "BL";
    case ROARM_CAL_CORNER_BR: return "BR";
    case ROARM_PENDING_EXIT: return "EXIT";
    default: return "?";
    }
}

static rt_uint8_t roarm_place_category_clamp(rt_uint8_t category)
{
    return (category < ROARM_PLACE_CATEGORY_COUNT) ? category : 0U;
}

static int roarm_pending_place_category(void)
{
    if ((g_pending_corner <= ROARM_PENDING_PLACE_BASE) &&
        (g_pending_corner > (ROARM_PENDING_PLACE_BASE - (int)ROARM_PLACE_CATEGORY_COUNT)))
    {
        return ROARM_PENDING_PLACE_BASE - g_pending_corner;
    }

    return -1;
}

static void fixed10_to_str(int32_t v10, char *buf, rt_size_t bufsz)
{
    int32_t av;

    if ((buf == RT_NULL) || (bufsz == 0U))
    {
        return;
    }

    av = abs_i32(v10);
    if (v10 < 0)
    {
        rt_snprintf(buf, bufsz, "-%ld.%ld", (long)(av / 10), (long)(av % 10));
    }
    else
    {
        rt_snprintf(buf, bufsz, "%ld.%ld", (long)(av / 10), (long)(av % 10));
    }
}

#ifdef BSP_USING_IPC
static int roarm_ipc_open_once(void)
{
    if (g_ipc_dev != RT_NULL)
    {
        return RT_EOK;
    }

    g_ipc_dev = edge_ipc_device_find();
    if (g_ipc_dev == RT_NULL)
    {
        if (edge_ipc_device_register() != RT_EOK)
        {
            return -RT_ERROR;
        }

        g_ipc_dev = edge_ipc_device_find();
        if (g_ipc_dev == RT_NULL)
        {
            return -RT_ERROR;
        }
    }

    if (rt_device_open(g_ipc_dev, RT_DEVICE_FLAG_RDWR) != RT_EOK)
    {
        g_ipc_dev = RT_NULL;
        return -RT_ERROR;
    }

    return RT_EOK;
}

/* Send short text chunks to M55 through IPC. */
static void roarm_ipc_send_text(rt_uint16_t msg_type, const char *text)
{
    const char *p;
    rt_uint32_t chunk_id = 0;

    if ((text == RT_NULL) || (text[0] == '\0'))
    {
        return;
    }

    if (roarm_ipc_open_once() != RT_EOK)
    {
        return;
    }

    p = text;

    while (*p != '\0')
    {
        edge_rc_frame_t frame;
        rt_uint16_t len = 0;
        rt_uint16_t i;
        rt_uint16_t meta;
        char buf[IPC_TEXT_CHUNK_BYTES];

        memset(buf, 0, sizeof(buf));

        while ((len < IPC_TEXT_CHUNK_BYTES) && (p[len] != '\0'))
        {
            buf[len] = p[len];
            len++;
        }

        p += len;

        memset(&frame, 0, sizeof(frame));
        frame.role = RC_ROLE_M33;
        frame.seq = ++g_ipc_text_seq;

        meta = (rt_uint16_t)(chunk_id & 0x7FFFU);
        if (*p == '\0')
        {
            meta |= 0x8000U;
        }

        frame.channel[0] = msg_type;
        frame.channel[1] = meta;
        frame.channel[2] = len;

        for (i = 0; i < 5U; i++)
        {
            rt_uint8_t lo = (rt_uint8_t)buf[i * 2U];
            rt_uint8_t hi = (rt_uint8_t)buf[i * 2U + 1U];
            frame.channel[3U + i] = (rt_uint16_t)(lo | ((rt_uint16_t)hi << 8));
        }

        rt_device_write(g_ipc_dev, 0, &frame, 1);
        chunk_id++;
    }
}
#else
static void roarm_ipc_send_text(rt_uint16_t msg_type, const char *text)
{
    (void)msg_type;
    (void)text;
}
#endif

void roarm_debug_printf(const char *fmt, ...)
{
    char buf[ROARM_DEBUG_BUF_SIZE];
    va_list args;

    if (fmt == RT_NULL)
    {
        return;
    }

    memset(buf, 0, sizeof(buf));

    va_start(args, fmt);
    rt_vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);

    roarm_ipc_send_text(VISION_IPC_MSG_ROARM_TX, buf);
}

void roarm_debug_vision_received(const roarm_vision_target_t *target)
{
    if (target == RT_NULL)
    {
        roarm_debug_printf("[M33<-M55] null target\r\n");
        return;
    }

    roarm_debug_printf("[M33<-M55] target category=%u cx=%u cy=%u bbox=[%u,%u,%u,%u] score=%u seq=%lu\r\n",
                       (unsigned)target->category,
                       target->cx,
                       target->cy,
                       target->x1,
                       target->y1,
                       target->x2,
                       target->y2,
                       target->score_x1000,
                       (unsigned long)target->seq);
}

static void roarm_action_mark_busy(rt_uint32_t seq)
{
    g_roarm_action_busy = 1U;
    g_roarm_action_busy_tick = rt_tick_get();
    g_roarm_action_seq = seq;
}

static void roarm_action_clear_busy(const char *reason)
{
    if (g_roarm_action_busy)
    {
        roarm_debug_printf("[M33 GRAB] action window clear: seq=%lu reason=%s\r\n",
                           (unsigned long)g_roarm_action_seq,
                           reason ? reason : "done");
    }
    g_roarm_action_busy = 0U;
    g_roarm_action_busy_tick = 0;
    g_roarm_action_seq = 0U;
}

static rt_uint8_t roarm_action_busy_active(void)
{
    rt_tick_t now;
    rt_tick_t timeout_ticks;

    if (!g_roarm_action_busy)
    {
        return 0U;
    }

    now = rt_tick_get();
    timeout_ticks = roarm_ms_to_tick(ROARM_ACTION_BUSY_TIMEOUT_MS);
    if ((now - g_roarm_action_busy_tick) >= timeout_ticks)
    {
        roarm_debug_printf("[M33 GRAB] action window timeout: seq=%lu, release busy lock\r\n",
                           (unsigned long)g_roarm_action_seq);
        g_exit_after_pick_pending = 0U;
        g_place_after_pick_pending = 0U;
        g_exit_after_place_pending = 0U;
        roarm_action_clear_busy("timeout");
        return 0U;
    }

    return 1U;
}

static int roarm_uart_open_once(void)
{
    struct serial_configure config = RT_SERIAL_CONFIG_DEFAULT;

    if (g_roarm_uart != RT_NULL)
    {
        return RT_EOK;
    }

    g_roarm_uart = rt_device_find(ROARM_UART_NAME);
    if (g_roarm_uart == RT_NULL)
    {
        if (!g_uart_open_reported_fail)
        {
            g_uart_open_reported_fail = 1U;
            roarm_debug_printf("[M33 UART] ERROR: rt_device_find(%s) failed\r\n", ROARM_UART_NAME);
        }
        return -RT_ERROR;
    }

    config.baud_rate = ROARM_UART_BAUD;
    config.data_bits = DATA_BITS_8;
    config.stop_bits = STOP_BITS_1;
    config.parity    = PARITY_NONE;
    config.bufsz     = 512;

    rt_device_control(g_roarm_uart, RT_DEVICE_CTRL_CONFIG, &config);

    if (rt_device_open(g_roarm_uart, RT_DEVICE_FLAG_RDWR | RT_DEVICE_FLAG_INT_RX) != RT_EOK)
    {
        g_roarm_uart = RT_NULL;
        if (!g_uart_open_reported_fail)
        {
            g_uart_open_reported_fail = 1U;
            roarm_debug_printf("[M33 UART] ERROR: open %s failed\r\n", ROARM_UART_NAME);
        }
        return -RT_ERROR;
    }

    if (!g_uart_open_reported_ok)
    {
        g_uart_open_reported_ok = 1U;
#if ROARM_USE_SOFT_UART_TX
        soft_uart_tx_init();
        roarm_debug_printf("[M33 UART] opened dev=%s baud=115200 8N1 RX-only; softTX=%s baud=%lu core=%lu bit_cycles=%lu guard_bits=%u\r\n",
                           ROARM_UART_NAME,
                           soft_uart_tx_pin_name(),
                           (unsigned long)SOFT_UART_TX_BAUD,
                           (unsigned long)soft_uart_tx_core_hz(),
                           (unsigned long)soft_uart_tx_bit_cycles(),
                           (unsigned int)SOFT_UART_TX_GUARD_BITS);
#else
        roarm_debug_printf("[M33 UART] opened dev=%s baud=115200 8N1 hwTX\r\n", ROARM_UART_NAME);
#endif
    }

    return RT_EOK;
}

static int roarm_uart_tx_lock(void)
{
    if (g_uart_tx_mutex == RT_NULL)
    {
        g_uart_tx_mutex = rt_mutex_create("ru_tx", RT_IPC_FLAG_PRIO);
        if (g_uart_tx_mutex == RT_NULL)
        {
            return -RT_ERROR;
        }
    }

    return rt_mutex_take(g_uart_tx_mutex, RT_WAITING_FOREVER);
}

static void roarm_uart_tx_unlock(void)
{
    if (g_uart_tx_mutex != RT_NULL)
    {
        rt_mutex_release(g_uart_tx_mutex);
    }
}

static void roarm_uart_rx_drain(void)
{
    char dump[32];

    if (g_roarm_uart == RT_NULL)
    {
        return;
    }

    while (rt_device_read(g_roarm_uart, 0, dump, sizeof(dump)) > 0)
    {
        /* Drop stale bytes from previous failed frames. */
    }
}

int roarm_uart_send_line(const char *line)
{
    char tx_buf[ROARM_TX_BUF_SIZE];
    rt_size_t len;
    rt_size_t tx_len;
    rt_size_t written;
    rt_uint8_t add_lf = 0U;
    rt_uint8_t last_byte;

    if (line == RT_NULL)
    {
        roarm_debug_printf("[M33->ARM] ERROR: null line\r\n");
        return -RT_EINVAL;
    }

    len = (rt_size_t)strlen(line);
    if (len == 0U)
    {
        roarm_debug_printf("[M33->ARM] ERROR: empty line\r\n");
        return -RT_EINVAL;
    }

    if (len >= (ROARM_TX_BUF_SIZE - 1U))
    {
        roarm_debug_printf("[M33->ARM] ERROR: line too long len=%lu\r\n", (unsigned long)len);
        return -RT_EINVAL;
    }

    memset(tx_buf, 0, sizeof(tx_buf));
    memcpy(tx_buf, line, len);
    tx_len = len;

    if ((line[len - 1U] != '\n') && (line[len - 1U] != '\r'))
    {
        tx_buf[tx_len++] = '\n';
        add_lf = 1U;
    }

    last_byte = (rt_uint8_t)tx_buf[tx_len - 1U];

    if (roarm_uart_open_once() != RT_EOK)
    {
        roarm_debug_printf("[M33 UART] ERROR: cannot send, uart not open\r\n");
        return -RT_ERROR;
    }

    if (roarm_uart_tx_lock() != RT_EOK)
    {
        roarm_debug_printf("[M33 UART] ERROR: tx mutex failed\r\n");
        return -RT_ERROR;
    }

    roarm_uart_rx_drain();

#if ROARM_USE_SOFT_UART_TX
    written = soft_uart_tx_write((const rt_uint8_t *)tx_buf, tx_len);
#else
    written = rt_device_write(g_roarm_uart, 0, tx_buf, tx_len);
#endif

    /* Do not drain RX after TX. T=105 calibration needs the immediate T=1051 reply. */
    roarm_uart_tx_unlock();

    roarm_debug_printf("[M33->ARM] %.*s%s", (int)len, line, add_lf ? " <LF>\r\n" : "");
#if ROARM_USE_SOFT_UART_TX
    roarm_debug_printf("[M33 SOFTTX] write=%lu/%lu pin=%s add_lf=%u last=0x%02X core=%lu bit_cycles=%lu flushed=1\r\n",
                       (unsigned long)written,
                       (unsigned long)tx_len,
                       soft_uart_tx_pin_name(),
                       (unsigned int)add_lf,
                       last_byte,
                       (unsigned long)soft_uart_tx_core_hz(),
                       (unsigned long)soft_uart_tx_bit_cycles());
#else
    roarm_debug_printf("[M33 UART] write=%lu/%lu dev=%s add_lf=%u last=0x%02X\r\n",
                       (unsigned long)written,
                       (unsigned long)tx_len,
                       ROARM_UART_NAME,
                       (unsigned int)add_lf,
                       last_byte);
#endif

    if (written != tx_len)
    {
        return -RT_ERROR;
    }

    return RT_EOK;
}

int roarm_test_query(void)
{
    roarm_debug_printf("[M33 ROARM] testarm query T=105\r\n");
    return roarm_uart_send_line("{\"T\":105}");
}

int roarm_test_tx00(void)
{
    rt_size_t written;

    if (roarm_uart_open_once() != RT_EOK)
    {
        roarm_debug_printf("[M33 TESTTX] ERROR: uart/softtx not open\r\n");
        return -RT_ERROR;
    }

    if (roarm_uart_tx_lock() != RT_EOK)
    {
        roarm_debug_printf("[M33 TESTTX] ERROR: tx mutex failed\r\n");
        return -RT_ERROR;
    }

    roarm_uart_rx_drain();

#if ROARM_USE_SOFT_UART_TX
    written = soft_uart_tx_write_byte(0x00U);
#else
    {
        const rt_uint8_t b = 0x00U;
        written = rt_device_write(g_roarm_uart, 0, &b, 1);
    }
#endif

    /* Do not drain RX after TX. */
    roarm_uart_tx_unlock();

    roarm_debug_printf("[M33 TESTTX] raw one byte 0x00 write=%lu/1 softTX=%s baud=%lu core=%lu bit_cycles=%lu flushed=1\r\n",
                       (unsigned long)written,
                       soft_uart_tx_pin_name(),
                       (unsigned long)SOFT_UART_TX_BAUD,
                       (unsigned long)soft_uart_tx_core_hz(),
                       (unsigned long)soft_uart_tx_bit_cycles());

    return (written == 1U) ? RT_EOK : -RT_ERROR;
}

static const char *find_json_value_start(const char *line, const char *key)
{
    const char *p;
    const char *colon;

    if ((line == RT_NULL) || (key == RT_NULL))
    {
        return RT_NULL;
    }

    p = strstr(line, key);
    if (p == RT_NULL)
    {
        return RT_NULL;
    }

    colon = strchr(p, ':');
    if (colon == RT_NULL)
    {
        return RT_NULL;
    }

    colon++;
    while ((*colon == ' ') || (*colon == '\t'))
    {
        colon++;
    }

    return colon;
}

static int parse_json_int(const char *line, const char *key, int32_t *out)
{
    const char *p;
    int sign = 1;
    int32_t value = 0;
    rt_uint8_t got_digit = 0U;

    if (out == RT_NULL)
    {
        return -RT_EINVAL;
    }

    p = find_json_value_start(line, key);
    if (p == RT_NULL)
    {
        return -RT_ERROR;
    }

    if (*p == '-')
    {
        sign = -1;
        p++;
    }

    while ((*p >= '0') && (*p <= '9'))
    {
        got_digit = 1U;
        value = (value * 10) + (int32_t)(*p - '0');
        p++;
    }

    if (!got_digit)
    {
        return -RT_ERROR;
    }

    *out = (sign < 0) ? -value : value;
    return RT_EOK;
}

static int parse_json_fixed10(const char *line, const char *key, int32_t *out10)
{
    const char *p;
    int sign = 1;
    int32_t whole = 0;
    int32_t frac = 0;
    rt_uint8_t got_digit = 0U;

    if (out10 == RT_NULL)
    {
        return -RT_EINVAL;
    }

    p = find_json_value_start(line, key);
    if (p == RT_NULL)
    {
        return -RT_ERROR;
    }

    if (*p == '-')
    {
        sign = -1;
        p++;
    }

    while ((*p >= '0') && (*p <= '9'))
    {
        got_digit = 1U;
        whole = (whole * 10) + (int32_t)(*p - '0');
        p++;
    }

    if (*p == '.')
    {
        p++;
        if ((*p >= '0') && (*p <= '9'))
        {
            frac = (int32_t)(*p - '0');
        }
    }

    if (!got_digit)
    {
        return -RT_ERROR;
    }

    *out10 = (sign < 0) ? -((whole * 10) + frac) : ((whole * 10) + frac);
    return RT_EOK;
}

static int roarm_parse_state_feedback(const char *line, int32_t *x10, int32_t *y10, int32_t *z10, int32_t *t10)
{
    int32_t t = 0;

    if ((line == RT_NULL) || (x10 == RT_NULL) || (y10 == RT_NULL) || (z10 == RT_NULL))
    {
        return -RT_EINVAL;
    }

    if (parse_json_int(line, "\"T\"", &t) != RT_EOK)
    {
        return -RT_ERROR;
    }

    if (t != 1051)
    {
        return -RT_ERROR;
    }

    if (parse_json_fixed10(line, "\"x\"", x10) != RT_EOK) return -RT_ERROR;
    if (parse_json_fixed10(line, "\"y\"", y10) != RT_EOK) return -RT_ERROR;
    if (parse_json_fixed10(line, "\"z\"", z10) != RT_EOK) return -RT_ERROR;

    if (t10 != RT_NULL)
    {
        if (parse_json_fixed10(line, "\"t\"", t10) != RT_EOK)
        {
            *t10 = 314;
        }
    }

    return RT_EOK;
}

static void roarm_recalculate_calibration(void)
{
    int i;
    int32_t zsum = 0;

    g_calibrated = 0U;

    for (i = 0; i < ROARM_CAL_CORNER_COUNT; i++)
    {
        if (!g_cal_points[i].valid)
        {
            return;
        }
        zsum += g_cal_points[i].z10;
    }

    g_desk_z10 = zsum / ROARM_CAL_CORNER_COUNT;
    g_calibrated = 1U;

    roarm_debug_printf("[M33 CAL] all corners valid. desk_z(avg)=%ld.%ld mm\r\n",
                       (long)(g_desk_z10 / 10),
                       (long)abs_i32(g_desk_z10 % 10));
}

static void roarm_handle_state_feedback_line(const char *line)
{
    int32_t x10 = 0;
    int32_t y10 = 0;
    int32_t z10 = 0;
    int32_t t10 = 314;
    int corner;
    int place_category;
    char xs[24], ys[24], zs[24], ts[24];

    if (roarm_parse_state_feedback(line, &x10, &y10, &z10, &t10) != RT_EOK)
    {
        return;
    }

    if (g_pending_corner == ROARM_PENDING_EXIT)
    {
        g_pending_corner = ROARM_PENDING_NONE;
        g_exit_point.valid = 1U;
        g_exit_point.x10 = x10;
        g_exit_point.y10 = y10;
        g_exit_point.z10 = z10;
        g_exit_point.t10 = t10;

        fixed10_to_str(x10, xs, sizeof(xs));
        fixed10_to_str(y10, ys, sizeof(ys));
        fixed10_to_str(z10, zs, sizeof(zs));
        fixed10_to_str(t10, ts, sizeof(ts));

        roarm_debug_printf("[M33 CAL] stored EXIT = arm(%s,%s,%s,t=%s) from T=1051\r\n",
                           xs, ys, zs, ts);
        return;
    }

    place_category = roarm_pending_place_category();
    if (place_category >= 0)
    {
        g_pending_corner = ROARM_PENDING_NONE;
        g_place_points[place_category].valid = 1U;
        g_place_points[place_category].x10 = x10;
        g_place_points[place_category].y10 = y10;
        g_place_points[place_category].z10 = z10;
        g_place_points[place_category].t10 = t10;

        fixed10_to_str(x10, xs, sizeof(xs));
        fixed10_to_str(y10, ys, sizeof(ys));
        fixed10_to_str(z10, zs, sizeof(zs));
        fixed10_to_str(t10, ts, sizeof(ts));

        roarm_debug_printf("[M33 PLACE] stored category=%d = arm(%s,%s,%s,t=%s) from T=1051\r\n",
                           place_category, xs, ys, zs, ts);
        return;
    }

    if ((g_pending_corner < 0) || (g_pending_corner >= ROARM_CAL_CORNER_COUNT))
    {
        return;
    }

    corner = g_pending_corner;
    g_pending_corner = ROARM_PENDING_NONE;

    g_cal_points[corner].valid = 1U;
    g_cal_points[corner].x10 = x10;
    g_cal_points[corner].y10 = y10;
    g_cal_points[corner].z10 = z10;
    g_cal_points[corner].t10 = t10;

    fixed10_to_str(x10, xs, sizeof(xs));
    fixed10_to_str(y10, ys, sizeof(ys));
    fixed10_to_str(z10, zs, sizeof(zs));
    fixed10_to_str(t10, ts, sizeof(ts));

    roarm_debug_printf("[M33 CAL] stored %s = arm(%s,%s,%s,t=%s) from T=1051\r\n",
                       roarm_corner_name(corner), xs, ys, zs, ts);

    roarm_recalculate_calibration();
}

int roarm_coord_cal_begin(void)
{
    g_grab_enabled = 0U;
    g_pending_corner = -1;
    g_pending_corner_tick = 0U;
    g_last_roarm_send_tick = 0U;

    roarm_recalculate_calibration();

    roarm_debug_printf("[M33 CAL] begin: release torque; saved corner calibration is kept. Re-run armcal_tl/tr/bl/br to update any corner\r\n");
    return roarm_uart_send_line("{\"T\":210,\"cmd\":0}");
}

int roarm_coord_capture_corner(roarm_cal_corner_t corner)
{
    if ((corner < 0) || (corner >= ROARM_CAL_CORNER_COUNT))
    {
        roarm_debug_printf("[M33 CAL] invalid corner id=%d\r\n", (int)corner);
        return -RT_EINVAL;
    }

    g_pending_corner = (int)corner;
    g_pending_corner_tick = rt_tick_get();

    roarm_debug_printf("[M33 CAL] capture %s: request RoArm state T=105\r\n", roarm_corner_name((int)corner));
    return roarm_uart_send_line("{\"T\":105}");
}

int roarm_coord_capture_exit(void)
{
    g_pending_corner = ROARM_PENDING_EXIT;
    g_pending_corner_tick = rt_tick_get();

    roarm_debug_printf("[M33 CAL] capture EXIT: drag arm to off-camera position, then request RoArm state T=105\r\n");
    return roarm_uart_send_line("{\"T\":105}");
}

void roarm_coord_show(void)
{
    int i;
    char xs[24], ys[24], zs[24], dz[24];

    roarm_debug_printf("[M33 CAL] status calibrated=%u grab_enabled=%u exit_valid=%u pending=%s image=%dx%d\r\n",
                       (unsigned)g_calibrated,
                       (unsigned)g_grab_enabled,
                       (unsigned)g_exit_point.valid,
                       (g_pending_corner != ROARM_PENDING_NONE) ? roarm_corner_name(g_pending_corner) : "none",
                       VISION_COORD_W,
                       VISION_COORD_H);

    for (i = 0; i < ROARM_CAL_CORNER_COUNT; i++)
    {
        if (g_cal_points[i].valid)
        {
            fixed10_to_str(g_cal_points[i].x10, xs, sizeof(xs));
            fixed10_to_str(g_cal_points[i].y10, ys, sizeof(ys));
            fixed10_to_str(g_cal_points[i].z10, zs, sizeof(zs));
            roarm_debug_printf("[M33 CAL] %s=(%s,%s,%s)\r\n", roarm_corner_name(i), xs, ys, zs);
        }
        else
        {
            roarm_debug_printf("[M33 CAL] %s=INVALID\r\n", roarm_corner_name(i));
        }
    }

    if (g_exit_point.valid)
    {
        char ex[24], ey[24], ez[24], et[24];
        fixed10_to_str(g_exit_point.x10, ex, sizeof(ex));
        fixed10_to_str(g_exit_point.y10, ey, sizeof(ey));
        fixed10_to_str(g_exit_point.z10, ez, sizeof(ez));
        fixed10_to_str(g_exit_point.t10, et, sizeof(et));
        roarm_debug_printf("[M33 CAL] EXIT=(%s,%s,%s,t=%s)\r\n", ex, ey, ez, et);
    }
    else
    {
        roarm_debug_printf("[M33 CAL] EXIT=INVALID; arm will not leave camera frame after pick\r\n");
    }

    fixed10_to_str(g_desk_z10, dz, sizeof(dz));
    roarm_debug_printf("[M33 MAP] u=px/319, v=py/319\r\n");
    roarm_debug_printf("[M33 MAP] X=(1-u)(1-v)TL.x+u(1-v)TR.x+(1-u)vBL.x+uvBR.x\r\n");
    roarm_debug_printf("[M33 MAP] Y=(1-u)(1-v)TL.y+u(1-v)TR.y+(1-u)vBL.y+uvBR.y\r\n");
    roarm_debug_printf("[M33 MAP] Zdesk=avg(TL.z,TR.z,BL.z,BR.z)=%s\r\n", dz);
}

int roarm_grab_start(void)
{
    roarm_action_clear_busy("grab_start");
    if (!g_calibrated)
    {
        roarm_debug_printf("[M33 GRAB] refused: calibration incomplete. Run armcal_start + four corner captures first.\r\n");
        return -RT_ERROR;
    }

    g_grab_enabled = 1U;
    g_last_roarm_send_tick = 0U;
    roarm_debug_printf("[M33 GRAB] enabled: torque on, next M55 target will become T=130 pick command\r\n");
    return roarm_uart_send_line("{\"T\":210,\"cmd\":1}");
}

int roarm_grab_stop(void)
{
    g_grab_enabled = 0U;
    g_exit_after_pick_pending = 0U;
    g_place_after_pick_pending = 0U;
    g_exit_after_place_pending = 0U;
    g_last_roarm_send_tick = 0U;
    roarm_action_clear_busy("grab_stop");
    roarm_debug_printf("[M33 GRAB] disabled: incoming vision targets will be ignored\r\n");
    return RT_EOK;
}

int roarm_coord_cal_stop(void)
{
    g_grab_enabled = 0U;
    g_exit_after_pick_pending = 0U;
    g_place_after_pick_pending = 0U;
    g_exit_after_place_pending = 0U;
    g_pending_corner = ROARM_PENDING_NONE;
    g_pending_corner_tick = 0U;
    g_last_roarm_send_tick = 0U;

    roarm_debug_printf("[M33 CAL] stop: torque on; saved corner calibration is kept\r\n");
    return roarm_uart_send_line("{\"T\":210,\"cmd\":1}");
}

int roarm_coord_clear_exit(void)
{
    memset(&g_exit_point, 0, sizeof(g_exit_point));
    g_exit_after_pick_pending = 0U;
    g_exit_after_place_pending = 0U;
    roarm_debug_printf("[M33 CAL] EXIT cleared; arm will not leave camera frame after pick\r\n");
    return RT_EOK;
}

int roarm_place_unlock(rt_uint8_t category)
{
    category = roarm_place_category_clamp(category);
    g_pending_corner = ROARM_PENDING_NONE;
    g_pending_corner_tick = 0U;
    roarm_debug_printf("[M33 PLACE] unlock category=%u: release torque, drag RoArm to place point, then run place_lock\r\n",
                       (unsigned)category);
    return roarm_uart_send_line("{\"T\":210,\"cmd\":0}");
}

int roarm_place_lock(rt_uint8_t category)
{
    category = roarm_place_category_clamp(category);
    g_pending_corner = ROARM_PENDING_PLACE_BASE - (int)category;
    g_pending_corner_tick = rt_tick_get();
    roarm_debug_printf("[M33 PLACE] lock category=%u: request RoArm state T=105\r\n", (unsigned)category);
    return roarm_uart_send_line("{\"T\":105}");
}

int roarm_place_clear(rt_uint8_t category)
{
    category = roarm_place_category_clamp(category);
    memset(&g_place_points[category], 0, sizeof(g_place_points[category]));
    roarm_debug_printf("[M33 PLACE] category=%u cleared\r\n", (unsigned)category);
    return RT_EOK;
}

void roarm_place_show(void)
{
    rt_uint8_t i;

    for (i = 0U; i < ROARM_PLACE_CATEGORY_COUNT; i++)
    {
        if (g_place_points[i].valid)
        {
            char xs[24], ys[24], zs[24], ts[24];
            fixed10_to_str(g_place_points[i].x10, xs, sizeof(xs));
            fixed10_to_str(g_place_points[i].y10, ys, sizeof(ys));
            fixed10_to_str(g_place_points[i].z10, zs, sizeof(zs));
            fixed10_to_str(g_place_points[i].t10, ts, sizeof(ts));
            roarm_debug_printf("[M33 PLACE] category=%u (%s,%s,%s,t=%s)\r\n",
                               (unsigned)i, xs, ys, zs, ts);
        }
        else
        {
            roarm_debug_printf("[M33 PLACE] category=%u INVALID\r\n", (unsigned)i);
        }
    }
}

int roarm_light_on(void)
{
    char json[ROARM_TX_BUF_SIZE];

    rt_snprintf(json, sizeof(json),
                "{\"T\":%d,\"led\":%d}",
                ROARM_LIGHT_CMD_T,
                ROARM_LIGHT_PWM);

    roarm_debug_printf("[M33 LIGHT] turn on RoArm head light led=%d\r\n", ROARM_LIGHT_PWM);
    return roarm_uart_send_line(json);
}

int roarm_light_off(void)
{
    char json[ROARM_TX_BUF_SIZE];

    rt_snprintf(json, sizeof(json),
                "{\"T\":%d,\"led\":0}",
                ROARM_LIGHT_CMD_T);

    roarm_debug_printf("[M33 LIGHT] turn off RoArm head light\r\n");
    return roarm_uart_send_line(json);
}

int roarm_arm_home(void)
{
    roarm_debug_printf("[M33 ARM] home T=%d\r\n", ROARM_HOME_CMD_T);
    return roarm_uart_send_line("{\"T\":102,\"base\":0,\"shoulder\":0,\"elbow\":1.57,\"hand\":1.57,\"spd\":0.25,\"acc\":10}");
}

static void roarm_build_exit_json(char *buf, rt_size_t bufsz)
{
    char xs[24], ys[24], zs[24], ts[24];

    if ((buf == RT_NULL) || (bufsz == 0U))
    {
        return;
    }

    if (!g_exit_point.valid)
    {
        rt_snprintf(buf, bufsz, "");
        return;
    }

    fixed10_to_str(g_exit_point.x10, xs, sizeof(xs));
    fixed10_to_str(g_exit_point.y10, ys, sizeof(ys));
    fixed10_to_str(g_exit_point.z10, zs, sizeof(zs));
    fixed10_to_str(g_exit_point.t10, ts, sizeof(ts));

    if (ts[0] == '\0')
    {
        rt_snprintf(ts, sizeof(ts), ROARM_EXIT_DEFAULT_T_STR);
    }

    rt_snprintf(buf, bufsz,
                "{\"T\":%d,\"x\":%s,\"y\":%s,\"z\":%s,\"t\":%s,\"spd\":%s}",
                ROARM_MOVE_XYZT_CMD_T,
                xs, ys, zs, ts,
                ROARM_EXIT_SPEED_STR);
}

static int roarm_move_to_exit_if_needed(void)
{
    char json[ROARM_TX_BUF_SIZE];
    int ret;

    if (!g_exit_after_pick_pending)
    {
        roarm_action_clear_busy("no exit pending");
        return RT_EOK;
    }

    g_exit_after_pick_pending = 0U;

    if (!g_exit_point.valid)
    {
        roarm_debug_printf("[M33 EXIT] skip: exit point not set\r\n");
        roarm_action_clear_busy("exit not set");
        return RT_EOK;
    }

    roarm_build_exit_json(json, sizeof(json));
    roarm_debug_printf("[M33 EXIT] move RoArm out of camera frame, then release action window\r\n");
    ret = roarm_uart_send_line(json);
    roarm_action_clear_busy("exit command sent");
    return ret;
}

static void roarm_build_place_json(rt_uint8_t category, char *buf, rt_size_t bufsz)
{
    roarm_cal_point_t *point;
    char xs[24], ys[24], zs[24];

    if ((buf == RT_NULL) || (bufsz == 0U))
    {
        return;
    }

    category = roarm_place_category_clamp(category);
    point = &g_place_points[category];
    if (!point->valid)
    {
        point = &g_place_points[0];
    }

    if (!point->valid)
    {
        rt_snprintf(buf, bufsz, "");
        return;
    }

    fixed10_to_str(point->x10, xs, sizeof(xs));
    fixed10_to_str(point->y10, ys, sizeof(ys));
    fixed10_to_str(point->z10, zs, sizeof(zs));

    rt_snprintf(buf, bufsz,
                "{\"T\":%d,\"x\":%s,\"y\":%s,\"z\":%s,\"spd\":%s,\"up\":%d,\"lift\":%d,\"open\":%s,\"close\":%s}",
                ROARM_PLACE_CMD_T,
                xs,
                ys,
                zs,
                ROARM_PLACE_SPEED_STR,
                ROARM_PLACE_APPROACH_MM,
                ROARM_PLACE_LIFT_MM,
                ROARM_GRIPPER_OPEN_STR,
                ROARM_GRIPPER_CLOSE_STR);
}

static int roarm_place_after_pick_if_needed(void)
{
    char json[ROARM_TX_BUF_SIZE];
    rt_uint8_t category;
    rt_uint8_t used_default = 0U;

    if (!g_place_after_pick_pending)
    {
        roarm_action_clear_busy("no place pending");
        return RT_EOK;
    }

    g_place_after_pick_pending = 0U;
    category = roarm_place_category_clamp(g_last_pick_category);

    if (!g_place_points[category].valid)
    {
        if (!g_place_points[0].valid)
        {
            roarm_debug_printf("[M33 PLACE] skip: no place point for category=%u and default category=0 is invalid\r\n",
                               (unsigned)category);
            g_exit_after_pick_pending = g_exit_point.valid ? 1U : 0U;
            return roarm_move_to_exit_if_needed();
        }
        used_default = 1U;
    }

    roarm_build_place_json(category, json, sizeof(json));
    g_exit_after_place_pending = g_exit_point.valid ? 1U : 0U;
    roarm_debug_printf("[M33 PLACE] send place T=%d category=%u%s\r\n",
                       ROARM_PLACE_CMD_T,
                       (unsigned)category,
                       used_default ? " fallback=0" : "");
    return roarm_uart_send_line(json);
}

static void roarm_map_vision_to_arm(const roarm_vision_target_t *target,
                                    int32_t *arm_x10,
                                    int32_t *arm_y10,
                                    int32_t *arm_z10)
{
    int64_t u;
    int64_t v;
    int64_t ux;
    int64_t vy;
    int64_t den;
    int64_t w_tl, w_tr, w_bl, w_br;
    int32_t px;
    int32_t py;

    if ((target == RT_NULL) || (arm_x10 == RT_NULL) || (arm_y10 == RT_NULL) || (arm_z10 == RT_NULL))
    {
        return;
    }

    px = clamp_i32((int32_t)target->cx, 0, VISION_COORD_X_MAX);
    py = clamp_i32((int32_t)target->cy, 0, VISION_COORD_Y_MAX);

    u = (int64_t)px;
    v = (int64_t)py;
    ux = (int64_t)VISION_COORD_X_MAX - u;
    vy = (int64_t)VISION_COORD_Y_MAX - v;
    den = (int64_t)VISION_COORD_X_MAX * (int64_t)VISION_COORD_Y_MAX;

    w_tl = ux * vy;
    w_tr = u * vy;
    w_bl = ux * v;
    w_br = u * v;

    *arm_x10 = (int32_t)((w_tl * g_cal_points[ROARM_CAL_CORNER_TL].x10 +
                          w_tr * g_cal_points[ROARM_CAL_CORNER_TR].x10 +
                          w_bl * g_cal_points[ROARM_CAL_CORNER_BL].x10 +
                          w_br * g_cal_points[ROARM_CAL_CORNER_BR].x10) / den);

    *arm_y10 = (int32_t)((w_tl * g_cal_points[ROARM_CAL_CORNER_TL].y10 +
                          w_tr * g_cal_points[ROARM_CAL_CORNER_TR].y10 +
                          w_bl * g_cal_points[ROARM_CAL_CORNER_BL].y10 +
                          w_br * g_cal_points[ROARM_CAL_CORNER_BR].y10) / den);

    *arm_z10 = g_desk_z10;
}

static void roarm_build_pick_json(const roarm_vision_target_t *target, char *buf, rt_size_t bufsz)
{
    int32_t arm_x10 = 0;
    int32_t arm_y10 = 0;
    int32_t arm_z10 = 0;
    char xs[24], ys[24], zs[24];

    roarm_map_vision_to_arm(target, &arm_x10, &arm_y10, &arm_z10);

    fixed10_to_str(arm_x10, xs, sizeof(xs));
    fixed10_to_str(arm_y10, ys, sizeof(ys));
    fixed10_to_str(arm_z10, zs, sizeof(zs));

    rt_snprintf(buf, bufsz,
                "{\"T\":%d,\"x\":%s,\"y\":%s,\"z\":%s,\"spd\":%s,\"up\":%d,\"lift\":%d,\"open\":%s,\"close\":%s}",
                ROARM_PICK_CMD_T,
                xs,
                ys,
                zs,
                ROARM_PICK_SPEED_STR,
                ROARM_PICK_APPROACH_MM,
                ROARM_PICK_LIFT_MM,
                ROARM_GRIPPER_OPEN_STR,
                ROARM_GRIPPER_CLOSE_STR);
}

static void roarm_handle_pick_ack_line(const char *line)
{
    int32_t t = 0;
    int32_t ok = 0;

    if (line == RT_NULL)
    {
        return;
    }

    if (parse_json_int(line, "\"T\"", &t) != RT_EOK)
    {
        return;
    }

    if ((t != ROARM_PICK_ACK_T) && (t != ROARM_PLACE_ACK_T))
    {
        return;
    }

    if (parse_json_int(line, "\"ok\"", &ok) != RT_EOK)
    {
        ok = 1;
    }

    if (t == ROARM_PLACE_ACK_T)
    {
        roarm_debug_printf("[M33 PLACE] RoArm place ack T=%d ok=%ld\r\n", ROARM_PLACE_ACK_T, (long)ok);

        if ((ok != 0) && g_exit_after_place_pending)
        {
            g_exit_after_place_pending = 0U;
            g_exit_after_pick_pending = g_exit_point.valid ? 1U : 0U;
            (void)roarm_move_to_exit_if_needed();
        }
        else
        {
            g_exit_after_place_pending = 0U;
            roarm_action_clear_busy((ok != 0) ? "place ack done" : "place failed");
        }
        return;
    }

    roarm_debug_printf("[M33 GRAB] RoArm pick ack T=%d ok=%ld\r\n", ROARM_PICK_ACK_T, (long)ok);

    if (ok != 0)
    {
        (void)roarm_place_after_pick_if_needed();
    }
    else
    {
        g_exit_after_pick_pending = 0U;
        g_place_after_pick_pending = 0U;
        g_exit_after_place_pending = 0U;
        roarm_debug_printf("[M33 PLACE] skip: pick failed\r\n");
        roarm_action_clear_busy("pick failed");
    }
}

void roarm_on_vision_pen(const roarm_vision_target_t *target)
{
    char json[ROARM_TX_BUF_SIZE];
    rt_tick_t now;
    rt_tick_t interval_ticks;
    int32_t arm_x10 = 0;
    int32_t arm_y10 = 0;
    int32_t arm_z10 = 0;
    char xs[24], ys[24], zs[24];

    if ((target == RT_NULL) || (!target->valid))
    {
        roarm_debug_printf("[M33 GRAB] skip invalid vision target\r\n");
        return;
    }

    if (!g_grab_enabled)
    {
        roarm_debug_printf("[M33 GRAB] skip target seq=%lu: grab disabled\r\n", (unsigned long)target->seq);
        return;
    }

    if (!g_calibrated)
    {
        roarm_debug_printf("[M33 GRAB] skip target seq=%lu: calibration incomplete\r\n", (unsigned long)target->seq);
        return;
    }

    if (roarm_action_busy_active())
    {
        roarm_debug_printf("[M33 GRAB] skip target seq=%lu: previous pick/place/exit still running seq=%lu\r\n",
                           (unsigned long)target->seq,
                           (unsigned long)g_roarm_action_seq);
        return;
    }

    roarm_map_vision_to_arm(target, &arm_x10, &arm_y10, &arm_z10);
    fixed10_to_str(arm_x10, xs, sizeof(xs));
    fixed10_to_str(arm_y10, ys, sizeof(ys));
    fixed10_to_str(arm_z10, zs, sizeof(zs));

    roarm_debug_printf("[M33 MAP] pixel=(%u,%u) -> arm=(%s,%s,%s) score=%u\r\n",
                       target->cx,
                       target->cy,
                       xs,
                       ys,
                       zs,
                       target->score_x1000);

    now = rt_tick_get();
    interval_ticks = roarm_ms_to_tick(ROARM_MIN_SEND_INTERVAL_MS);

    if ((g_last_roarm_send_tick != 0U) &&
        ((now - g_last_roarm_send_tick) < interval_ticks))
    {
        roarm_debug_printf("[M33 GRAB] skip throttled seq=%lu\r\n", (unsigned long)target->seq);
        return;
    }

    roarm_build_pick_json(target, json, sizeof(json));
    roarm_debug_printf("[M33 GRAB] send pick T=%d seq=%lu\r\n",
                       ROARM_PICK_CMD_T,
                       (unsigned long)target->seq);

    if (roarm_uart_send_line(json) == RT_EOK)
    {
        g_last_roarm_send_tick = now;
        roarm_action_mark_busy(target->seq);
        g_last_pick_category = roarm_place_category_clamp(target->category);
        g_place_after_pick_pending = 1U;
        g_exit_after_pick_pending = 0U;
        g_exit_after_place_pending = 0U;
        if (g_place_points[g_last_pick_category].valid || g_place_points[0].valid)
        {
            roarm_debug_printf("[M33 PLACE] armed: category=%u will place after RoArm T=1301 ack\r\n",
                               (unsigned)g_last_pick_category);
        }
        else if (g_exit_point.valid)
        {
            roarm_debug_printf("[M33 PLACE] no place point, will exit after RoArm T=1301 ack\r\n");
        }
    }
}

static void roarm_uart_flush_rx_line(char *line, rt_size_t *pos, const char *tag)
{
    char out[ROARM_LINE_BUF_SIZE + 48U];

    if ((line == RT_NULL) || (pos == RT_NULL) || (*pos == 0U))
    {
        return;
    }

    line[*pos] = '\0';

    /* Store calibration point if this line is a RoArm T=1051 state feedback. */
    roarm_handle_state_feedback_line(line);
    /* Move out of camera frame after a successful RoArm pick ack if EXIT is set. */
    roarm_handle_pick_ack_line(line);

    rt_snprintf(out, sizeof(out), "%s %s\r\n", tag, line);
    roarm_ipc_send_text(VISION_IPC_MSG_ROARM_RX, out);

    *pos = 0U;
    memset(line, 0, ROARM_LINE_BUF_SIZE);
}

static void roarm_uart_rx_thread_entry(void *parameter)
{
    char line[ROARM_LINE_BUF_SIZE];
    rt_size_t pos = 0;
    rt_uint8_t ch;
    rt_tick_t last_byte_tick = 0;

    (void)parameter;

    while (roarm_uart_open_once() != RT_EOK)
    {
        rt_thread_mdelay(1000);
    }

    roarm_debug_printf("[M33 UART] rx thread started dev=%s\r\n", ROARM_UART_NAME);

    memset(line, 0, sizeof(line));

    while (1)
    {
        if (rt_device_read(g_roarm_uart, 0, &ch, 1) == 1)
        {
            last_byte_tick = rt_tick_get();

            if ((ch == '\r') || (ch == '\n'))
            {
                roarm_uart_flush_rx_line(line, &pos, "[ARM->M33]");
            }
            else
            {
                if (pos < (ROARM_LINE_BUF_SIZE - 1U))
                {
                    line[pos++] = (char)ch;
                }
                else
                {
                    roarm_uart_flush_rx_line(line, &pos, "[ARM->M33/PART]");
                }
            }
        }
        else
        {
            if ((pos > 0U) && ((rt_tick_get() - last_byte_tick) >= roarm_ms_to_tick(ROARM_RX_PARTIAL_FLUSH_MS)))
            {
                roarm_uart_flush_rx_line(line, &pos, "[ARM->M33/PART]");
            }

            if ((g_pending_corner != ROARM_PENDING_NONE) &&
                ((rt_tick_get() - g_pending_corner_tick) >= roarm_ms_to_tick(3000U)))
            {
                roarm_debug_printf("[M33 CAL] warning: waiting T=1051 for %s more than 3s\r\n",
                                   roarm_corner_name(g_pending_corner));
                g_pending_corner_tick = rt_tick_get();
            }

            rt_thread_mdelay(10);
        }
    }
}

#if ROARM_BOOT_QUERY_ENABLE
static void roarm_boot_thread_entry(void *parameter)
{
    (void)parameter;

    rt_thread_mdelay(ROARM_BOOT_QUERY_DELAY_MS);

    roarm_debug_printf("[M33 ROARM] boot safe query start\r\n");
    roarm_uart_send_line("{\"T\":105}");
}
#endif

int roarm_uart_init(void)
{
    if (roarm_uart_open_once() != RT_EOK)
    {
        return -RT_ERROR;
    }

    if (g_roarm_rx_tid == RT_NULL)
    {
        g_roarm_rx_tid = rt_thread_create("ru_rx",
                                          roarm_uart_rx_thread_entry,
                                          RT_NULL,
                                          ROARM_UART_RX_THREAD_STACK,
                                          ROARM_UART_RX_THREAD_PRIO,
                                          ROARM_UART_RX_THREAD_TICK);

        if (g_roarm_rx_tid == RT_NULL)
        {
            roarm_debug_printf("[M33 UART] ERROR: create rx thread failed\r\n");
            return -RT_ERROR;
        }

        rt_thread_startup(g_roarm_rx_tid);
    }

#if ROARM_BOOT_QUERY_ENABLE
    if (g_roarm_boot_tid == RT_NULL)
    {
        g_roarm_boot_tid = rt_thread_create("ru_boot",
                                            roarm_boot_thread_entry,
                                            RT_NULL,
                                            ROARM_BOOT_THREAD_STACK,
                                            ROARM_BOOT_THREAD_PRIO,
                                            ROARM_BOOT_THREAD_TICK);
        if (g_roarm_boot_tid != RT_NULL)
        {
            rt_thread_startup(g_roarm_boot_tid);
        }
    }
#endif

    return RT_EOK;
}
INIT_APP_EXPORT(roarm_uart_init);

#ifdef FINSH_USING_MSH
static int roarm_send(int argc, char **argv)
{
    if (argc < 2)
    {
        rt_kprintf("Usage: roarm_send '{\"T\":105}'\r\n");
        return -RT_EINVAL;
    }

    return roarm_uart_send_line(argv[1]);
}
MSH_CMD_EXPORT(roarm_send, send one JSON line to RoArm UART);

static int roarm_cal_show(int argc, char **argv)
{
    (void)argc;
    (void)argv;
    roarm_coord_show();
    return 0;
}
MSH_CMD_EXPORT(roarm_cal_show, M33 local show coordinate calibration);
#endif
