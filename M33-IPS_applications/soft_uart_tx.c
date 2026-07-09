#include <rtthread.h>
#include <rthw.h>
#include <stdint.h>
#include "cy_device_headers.h"
#include "soft_uart_tx.h"

static rt_uint8_t g_soft_uart_tx_inited = 0U;
static rt_uint32_t g_soft_uart_bit_cycles = 0U;
static rt_uint32_t g_soft_uart_core_hz = 0U;

static inline rt_uint32_t soft_uart_tx_cycles_now(void)
{
    return DWT->CYCCNT;
}

static inline void soft_uart_tx_wait_until(rt_uint32_t target)
{
    while ((int32_t)(soft_uart_tx_cycles_now() - target) < 0)
    {
        __NOP();
    }
}

static inline void soft_uart_tx_wait_cycles(rt_uint32_t cycles)
{
    rt_uint32_t target = soft_uart_tx_cycles_now() + cycles;
    soft_uart_tx_wait_until(target);
}

static inline void soft_uart_tx_write_level(rt_uint8_t logical_high)
{
#if SOFT_UART_TX_INVERT
    logical_high = logical_high ? 0U : 1U;
#endif
    Cy_GPIO_Write(SOFT_UART_TX_PORT, SOFT_UART_TX_PIN, logical_high ? 1U : 0U);
}

static inline void soft_uart_tx_idle(void)
{
    soft_uart_tx_write_level(1U);
}

static inline void soft_uart_tx_start_bit(void)
{
    soft_uart_tx_write_level(0U);
}

const char *soft_uart_tx_pin_name(void)
{
    return SOFT_UART_TX_PIN_NAME;
}

rt_uint32_t soft_uart_tx_bit_cycles(void)
{
    return g_soft_uart_bit_cycles;
}

rt_uint32_t soft_uart_tx_core_hz(void)
{
    return g_soft_uart_core_hz;
}

static void soft_uart_tx_dwt_init(void)
{
    /* Make SystemCoreClock as fresh as possible. If it is stale, the bit time
     * will be wrong and the receiver will decode random-looking bytes.
     */
    SystemCoreClockUpdate();
    g_soft_uart_core_hz = (rt_uint32_t)SystemCoreClock;

    CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
    DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;

    /* Rounded cycle count for one UART bit. */
    g_soft_uart_bit_cycles = (rt_uint32_t)((g_soft_uart_core_hz + (SOFT_UART_TX_BAUD / 2UL)) / SOFT_UART_TX_BAUD);
    if (g_soft_uart_bit_cycles == 0U)
    {
        g_soft_uart_bit_cycles = 1U;
    }
}

int soft_uart_tx_init(void)
{
    if (!g_soft_uart_tx_inited)
    {
        soft_uart_tx_dwt_init();

        /* Force this pin to normal GPIO output and idle high. */
        Cy_GPIO_Pin_FastInit(SOFT_UART_TX_PORT,
                             SOFT_UART_TX_PIN,
                             CY_GPIO_DM_STRONG_IN_OFF,
                             1U,
                             HSIOM_SEL_GPIO);

        soft_uart_tx_idle();
        g_soft_uart_tx_inited = 1U;
    }
    else
    {
        /* Re-assert GPIO mode and idle high. This is intentional: if some BSP
         * or other code temporarily reused the pin, every send starts from a
         * known clean state.
         */
        Cy_GPIO_Pin_FastInit(SOFT_UART_TX_PORT,
                             SOFT_UART_TX_PIN,
                             CY_GPIO_DM_STRONG_IN_OFF,
                             1U,
                             HSIOM_SEL_GPIO);
        soft_uart_tx_idle();
    }

    return RT_EOK;
}

void soft_uart_tx_flush_line(void)
{
    rt_uint32_t guard_cycles;

    soft_uart_tx_init();
    soft_uart_tx_idle();

    guard_cycles = g_soft_uart_bit_cycles * (rt_uint32_t)SOFT_UART_TX_GUARD_BITS;
    if (guard_cycles == 0U)
    {
        guard_cycles = 1U;
    }

    soft_uart_tx_wait_cycles(guard_cycles);
    soft_uart_tx_idle();
}

static void soft_uart_tx_send_byte_locked(rt_uint8_t byte)
{
    int i;
    rt_uint32_t next;
    const rt_uint32_t bit_cycles = g_soft_uart_bit_cycles;

    /* UART 8N1: idle high, start low, 8 data bits LSB first, stop high.
     * Absolute DWT schedule: each bit boundary is tied to the start edge.
     */
    next = soft_uart_tx_cycles_now();

    soft_uart_tx_start_bit();
    next += bit_cycles;
    soft_uart_tx_wait_until(next);

    for (i = 0; i < 8; i++)
    {
        soft_uart_tx_write_level((byte & (1U << i)) ? 1U : 0U);
        next += bit_cycles;
        soft_uart_tx_wait_until(next);
    }

    soft_uart_tx_idle();
    next += bit_cycles;
    soft_uart_tx_wait_until(next);
}

rt_size_t soft_uart_tx_write_byte(rt_uint8_t byte)
{
    rt_base_t level;

    if (soft_uart_tx_init() != RT_EOK)
    {
        return 0U;
    }

    level = rt_hw_interrupt_disable();
    soft_uart_tx_flush_line();
    soft_uart_tx_send_byte_locked(byte);
    soft_uart_tx_flush_line();
    rt_hw_interrupt_enable(level);

    return 1U;
}

rt_size_t soft_uart_tx_write(const rt_uint8_t *data, rt_size_t len)
{
    rt_size_t i;
    rt_base_t level;

    if ((data == RT_NULL) || (len == 0U))
    {
        return 0U;
    }

    if (soft_uart_tx_init() != RT_EOK)
    {
        return 0U;
    }

    level = rt_hw_interrupt_disable();

    soft_uart_tx_flush_line();

    for (i = 0; i < len; i++)
    {
        soft_uart_tx_send_byte_locked(data[i]);
    }

    soft_uart_tx_flush_line();

    rt_hw_interrupt_enable(level);

    return len;
}
