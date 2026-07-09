#ifndef SOFT_UART_TX_H
#define SOFT_UART_TX_H

#include <rtthread.h>
#include <stdint.h>
#include "cycfg_pins.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * GPIO software UART TX for the M33 -> RoArm direction.
 *
 * Default TX pin:
 *   CYBSP_SPI_9_MOSI = P15_1 = 40Pin physical Pin 19 / MOSI / RPI_SPI_MOSI
 *
 * Wiring:
 *   Edgi-Talk 40Pin Pin 19 / MOSI  -> RoArm RX
 *   RoArm TX                       -> Edgi-Talk original UART5_RX
 *   GND                            -> GND
 */
#ifndef SOFT_UART_TX_PORT
#define SOFT_UART_TX_PORT            CYBSP_SPI_9_MOSI_PORT
#endif

#ifndef SOFT_UART_TX_PIN
#define SOFT_UART_TX_PIN             CYBSP_SPI_9_MOSI_PIN
#endif

#ifndef SOFT_UART_TX_PIN_NAME
#define SOFT_UART_TX_PIN_NAME        "CYBSP_SPI_9_MOSI/P15_1/40Pin19"
#endif

/* RoArm default UART: 115200 8N1. */
#ifndef SOFT_UART_TX_BAUD
#define SOFT_UART_TX_BAUD            115200UL
#endif

/* Keep normal TTL UART polarity: idle high, start bit low.
 * Set to 1 only if the scope proves the whole line is inverted.
 */
#ifndef SOFT_UART_TX_INVERT
#define SOFT_UART_TX_INVERT          0U
#endif

/* Idle guard before and after every software-UART frame group.
 * 24 bit-times ~= 208 us at 115200. This is not a human-visible delay,
 * but it gives the receiver enough idle-high time to resync and prevents
 * a previous bad frame from merging with the next frame.
 */
#ifndef SOFT_UART_TX_GUARD_BITS
#define SOFT_UART_TX_GUARD_BITS      24U
#endif

int soft_uart_tx_init(void);
rt_size_t soft_uart_tx_write(const rt_uint8_t *data, rt_size_t len);
rt_size_t soft_uart_tx_write_byte(rt_uint8_t byte);
void soft_uart_tx_flush_line(void);
const char *soft_uart_tx_pin_name(void);
rt_uint32_t soft_uart_tx_bit_cycles(void);
rt_uint32_t soft_uart_tx_core_hz(void);

#ifdef __cplusplus
}
#endif

#endif /* SOFT_UART_TX_H */
