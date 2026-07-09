#include <rtthread.h>
#include <rtdevice.h>
#include <stdint.h>
#include <string.h>

#ifdef BSP_USING_IPC
#include "drv_ipc.h"
#endif

#include "roarm_uart.h"

#define VISION_IPC_MSG_PEN_COORD       0x5501U
#define VISION_IPC_MSG_PEN_ACK         0x5502U
#define VISION_IPC_MSG_ARM_TEST_QUERY  0x5506U
#define VISION_IPC_MSG_ARM_TEST_TX00   0x5507U
#define VISION_IPC_MSG_CAL_CMD         0x5510U

#define CAL_CMD_BEGIN                  1U
#define CAL_CMD_CAPTURE_TL             2U
#define CAL_CMD_CAPTURE_TR             3U
#define CAL_CMD_CAPTURE_BL             4U
#define CAL_CMD_CAPTURE_BR             5U
#define CAL_CMD_SHOW                   6U
#define CAL_CMD_GRAB_START             7U
#define CAL_CMD_GRAB_STOP              8U
#define CAL_CMD_CAPTURE_EXIT           9U
#define CAL_CMD_LIGHT_ON               10U
#define CAL_CMD_LIGHT_OFF              11U
#define CAL_CMD_CAL_STOP               12U
#define CAL_CMD_EXIT_CLEAR             13U
#define CAL_CMD_EXIT_BEGIN             14U
#define CAL_CMD_ARM_HOME               15U
#define CAL_CMD_PLACE_UNLOCK           16U
#define CAL_CMD_PLACE_LOCK             17U
#define CAL_CMD_PLACE_CLEAR            18U
#define CAL_CMD_PLACE_SHOW             19U

#define VISION_SCORE_MASK              0x0FFFU
#define VISION_CATEGORY_SHIFT          12U

#define VISION_IPC_RX_THREAD_STACK     2048U
#define VISION_IPC_RX_THREAD_PRIO      18U
#define VISION_IPC_RX_THREAD_TICK      10U

#ifdef BSP_USING_IPC

static rt_device_t g_ipc_dev = RT_NULL;
static rt_thread_t g_ipc_rx_tid = RT_NULL;
static roarm_vision_target_t g_latest_target;

static int vision_ipc_open_once(void)
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
            roarm_debug_printf("[M33 IPC] ERROR: register failed\r\n");
            return -RT_ERROR;
        }

        g_ipc_dev = edge_ipc_device_find();
        if (g_ipc_dev == RT_NULL)
        {
            roarm_debug_printf("[M33 IPC] ERROR: device not found\r\n");
            return -RT_ERROR;
        }
    }

    if (rt_device_open(g_ipc_dev, RT_DEVICE_FLAG_RDWR) != RT_EOK)
    {
        roarm_debug_printf("[M33 IPC] ERROR: open failed\r\n");
        g_ipc_dev = RT_NULL;
        return -RT_ERROR;
    }

    roarm_debug_printf("[M33 IPC] vision rx opened\r\n");
    return RT_EOK;
}

static void vision_ipc_send_ack(const edge_rc_frame_t *rx_frame, rt_uint16_t status)
{
    edge_rc_frame_t ack;

    if ((g_ipc_dev == RT_NULL) || (rx_frame == RT_NULL))
    {
        return;
    }

    memset(&ack, 0, sizeof(ack));

    ack.role = RC_ROLE_M33;
    ack.seq = rx_frame->seq;

    ack.channel[0] = VISION_IPC_MSG_PEN_ACK;
    ack.channel[1] = rx_frame->channel[1];   /* cx */
    ack.channel[2] = rx_frame->channel[2];   /* cy */
    ack.channel[3] = rx_frame->channel[7];   /* score */
    ack.channel[4] = status;                 /* 2 = target handler called */

    rt_device_write(g_ipc_dev, 0, &ack, 1);
}

static void vision_ipc_handle_target_coord(const edge_rc_frame_t *frame)
{
    if (frame == RT_NULL)
    {
        roarm_debug_printf("[M33<-M55] ERROR: null IPC frame\r\n");
        return;
    }

    g_latest_target.valid = 1U;
    g_latest_target.seq = frame->seq;

    g_latest_target.cx = frame->channel[1];
    g_latest_target.cy = frame->channel[2];

    g_latest_target.x1 = frame->channel[3];
    g_latest_target.y1 = frame->channel[4];
    g_latest_target.x2 = frame->channel[5];
    g_latest_target.y2 = frame->channel[6];

    g_latest_target.score_x1000 = frame->channel[7] & VISION_SCORE_MASK;
    g_latest_target.category = (rt_uint8_t)(frame->channel[7] >> VISION_CATEGORY_SHIFT);
    g_latest_target.tick = rt_tick_get();

    roarm_debug_vision_received(&g_latest_target);
    roarm_on_vision_pen(&g_latest_target);
    vision_ipc_send_ack(frame, 2U);
}

static void vision_ipc_handle_arm_test_query(const edge_rc_frame_t *frame)
{
    int ret;

    (void)frame;

    ret = roarm_test_query();

    if (ret != RT_EOK)
    {
        roarm_debug_printf("[M33 TESTARM] send {\"T\":105} failed ret=%d\r\n", ret);
    }
}

static void vision_ipc_handle_arm_test_tx00(const edge_rc_frame_t *frame)
{
    int ret;

    (void)frame;

    ret = roarm_test_tx00();

    if (ret != RT_EOK)
    {
        roarm_debug_printf("[M33 TESTTX] send raw 0x00 failed ret=%d\r\n", ret);
    }
}

static void vision_ipc_handle_cal_cmd(const edge_rc_frame_t *frame)
{
    rt_uint16_t subcmd;
    int ret = RT_EOK;

    if (frame == RT_NULL)
    {
        return;
    }

    subcmd = frame->channel[1];

    switch (subcmd)
    {
    case CAL_CMD_BEGIN:
        ret = roarm_coord_cal_begin();
        break;

    case CAL_CMD_CAPTURE_TL:
        ret = roarm_coord_capture_corner(ROARM_CAL_CORNER_TL);
        break;

    case CAL_CMD_CAPTURE_TR:
        ret = roarm_coord_capture_corner(ROARM_CAL_CORNER_TR);
        break;

    case CAL_CMD_CAPTURE_BL:
        ret = roarm_coord_capture_corner(ROARM_CAL_CORNER_BL);
        break;

    case CAL_CMD_CAPTURE_BR:
        ret = roarm_coord_capture_corner(ROARM_CAL_CORNER_BR);
        break;

    case CAL_CMD_SHOW:
        roarm_coord_show();
        break;

    case CAL_CMD_GRAB_START:
        ret = roarm_grab_start();
        break;

    case CAL_CMD_GRAB_STOP:
        ret = roarm_grab_stop();
        break;

    case CAL_CMD_CAPTURE_EXIT:
        ret = roarm_coord_capture_exit();
        break;

    case CAL_CMD_LIGHT_ON:
        ret = roarm_light_on();
        break;

    case CAL_CMD_LIGHT_OFF:
        ret = roarm_light_off();
        break;

    case CAL_CMD_CAL_STOP:
        ret = roarm_coord_cal_stop();
        break;

    case CAL_CMD_EXIT_CLEAR:
        ret = roarm_coord_clear_exit();
        break;

    case CAL_CMD_EXIT_BEGIN:
        ret = roarm_coord_cal_begin();
        break;

    case CAL_CMD_ARM_HOME:
        ret = roarm_arm_home();
        break;

    case CAL_CMD_PLACE_UNLOCK:
        ret = roarm_place_unlock((rt_uint8_t)frame->channel[2]);
        break;

    case CAL_CMD_PLACE_LOCK:
        ret = roarm_place_lock((rt_uint8_t)frame->channel[2]);
        break;

    case CAL_CMD_PLACE_CLEAR:
        ret = roarm_place_clear((rt_uint8_t)frame->channel[2]);
        break;

    case CAL_CMD_PLACE_SHOW:
        roarm_place_show();
        break;

    default:
        roarm_debug_printf("[M33 CAL] unknown subcmd=%u\r\n", subcmd);
        ret = -RT_EINVAL;
        break;
    }

    if (ret != RT_EOK)
    {
        roarm_debug_printf("[M33 CAL] subcmd=%u ret=%d\r\n", subcmd, ret);
    }
}

static void vision_ipc_rx_thread_entry(void *parameter)
{
    edge_rc_frame_t frame;

    (void)parameter;

    if (vision_ipc_open_once() != RT_EOK)
    {
        roarm_debug_printf("[M33 IPC] rx thread exit: open failed\r\n");
        return;
    }

    roarm_debug_printf("[M33 IPC] vision rx thread started: target=0x%04X calcmd=0x%04X\r\n",
                       VISION_IPC_MSG_PEN_COORD,
                       VISION_IPC_MSG_CAL_CMD);

    while (1)
    {
        memset(&frame, 0, sizeof(frame));

        if (rt_device_read(g_ipc_dev, 0, &frame, 1) == 1)
        {
            if (frame.channel[0] == VISION_IPC_MSG_PEN_COORD)
            {
                vision_ipc_handle_target_coord(&frame);
            }
            else if (frame.channel[0] == VISION_IPC_MSG_CAL_CMD)
            {
                vision_ipc_handle_cal_cmd(&frame);
            }
            else if (frame.channel[0] == VISION_IPC_MSG_ARM_TEST_QUERY)
            {
                vision_ipc_handle_arm_test_query(&frame);
            }
            else if (frame.channel[0] == VISION_IPC_MSG_ARM_TEST_TX00)
            {
                vision_ipc_handle_arm_test_tx00(&frame);
            }
            else
            {
                /* Do not spam all non-vision frames. */
            }
        }
        else
        {
            rt_thread_mdelay(20);
        }
    }
}

int vision_ipc_rx_start(void)
{
    if (g_ipc_rx_tid != RT_NULL)
    {
        return RT_EOK;
    }

    g_ipc_rx_tid = rt_thread_create("vis_ipc",
                                    vision_ipc_rx_thread_entry,
                                    RT_NULL,
                                    VISION_IPC_RX_THREAD_STACK,
                                    VISION_IPC_RX_THREAD_PRIO,
                                    VISION_IPC_RX_THREAD_TICK);

    if (g_ipc_rx_tid == RT_NULL)
    {
        roarm_debug_printf("[M33 IPC] ERROR: create rx thread failed\r\n");
        return -RT_ERROR;
    }

    rt_thread_startup(g_ipc_rx_tid);
    return RT_EOK;
}

INIT_APP_EXPORT(vision_ipc_rx_start);

#ifdef FINSH_USING_MSH
static int vision_last_target(int argc, char **argv)
{
    rt_tick_t age_ms;

    (void)argc;
    (void)argv;

    if (!g_latest_target.valid)
    {
        rt_kprintf("No target coordinate received yet.\r\n");
        return 0;
    }

    age_ms = (rt_tick_get() - g_latest_target.tick) * 1000U / RT_TICK_PER_SECOND;

    rt_kprintf("Last target: cx=%u cy=%u bbox=[%u,%u,%u,%u] score=%u seq=%lu age=%lu ms\r\n",
               g_latest_target.cx,
               g_latest_target.cy,
               g_latest_target.x1,
               g_latest_target.y1,
               g_latest_target.x2,
               g_latest_target.y2,
               g_latest_target.score_x1000,
               (unsigned long)g_latest_target.seq,
               (unsigned long)age_ms);

    return 0;
}
MSH_CMD_EXPORT(vision_last_target, show latest target coordinate from M55);
#endif

#else

int vision_ipc_rx_start(void)
{
    return -RT_ERROR;
}

#endif
