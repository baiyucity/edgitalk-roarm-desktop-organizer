#ifndef ROARM_UART_H
#define ROARM_UART_H

#include <rtthread.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum
{
    ROARM_CAL_CORNER_TL = 0,
    ROARM_CAL_CORNER_TR = 1,
    ROARM_CAL_CORNER_BL = 2,
    ROARM_CAL_CORNER_BR = 3,
    ROARM_CAL_CORNER_COUNT = 4
} roarm_cal_corner_t;

typedef struct
{
    rt_uint8_t  valid;
    rt_uint32_t seq;

    rt_uint16_t cx;
    rt_uint16_t cy;

    rt_uint16_t x1;
    rt_uint16_t y1;
    rt_uint16_t x2;
    rt_uint16_t y2;

    rt_uint16_t score_x1000;
    rt_uint8_t  category;
    rt_tick_t   tick;
} roarm_vision_target_t;

int roarm_uart_init(void);
int roarm_uart_send_line(const char *line);
int roarm_test_query(void);
int roarm_test_tx00(void);

void roarm_on_vision_pen(const roarm_vision_target_t *target);

int roarm_coord_cal_begin(void);
int roarm_coord_capture_corner(roarm_cal_corner_t corner);
int roarm_coord_capture_exit(void);
void roarm_coord_show(void);
int roarm_grab_start(void);
int roarm_light_on(void);
int roarm_light_off(void);
int roarm_coord_cal_stop(void);
int roarm_coord_clear_exit(void);
int roarm_grab_stop(void);
int roarm_place_unlock(rt_uint8_t category);
int roarm_place_lock(rt_uint8_t category);
int roarm_place_clear(rt_uint8_t category);
void roarm_place_show(void);
int roarm_arm_home(void);

/* Debug text is forwarded to M55 through IPC, not printed into RoArm UART. */
void roarm_debug_printf(const char *fmt, ...);
void roarm_debug_vision_received(const roarm_vision_target_t *target);

#ifdef __cplusplus
}
#endif

#endif /* ROARM_UART_H */
