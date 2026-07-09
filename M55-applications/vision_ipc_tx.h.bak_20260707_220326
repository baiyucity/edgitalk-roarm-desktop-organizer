#ifndef VISION_IPC_TX_H
#define VISION_IPC_TX_H

#include "uvc_ai.h"

#ifdef __cplusplus
extern "C" {
#endif

void vision_ipc_try_send_result(const uvc_ai_result_t *result);
int vision_ipc_grab_stream_enabled(void);
int vision_ipc_armcal_start(void);
int vision_ipc_armcal_record_tl(void);
int vision_ipc_armcal_record_tr(void);
int vision_ipc_armcal_record_bl(void);
int vision_ipc_armcal_record_br(void);
int vision_ipc_armcal_show(void);
int vision_ipc_armcal_stop(void);
int vision_ipc_armcal_exit_start(void);
int vision_ipc_armcal_exit(void);
int vision_ipc_armcal_exit_clear(void);
int vision_ipc_grab_start(void);
int vision_ipc_grab_stop(void);
int vision_ipc_send_selected_target(rt_uint16_t cx,
                                    rt_uint16_t cy,
                                    rt_uint16_t x1,
                                    rt_uint16_t y1,
                                    rt_uint16_t x2,
                                    rt_uint16_t y2,
                                    rt_uint16_t score_x1000,
                                    const char *class_name,
                                    int target_id,
                                    int place_category);
int vision_ipc_arm_light_on(void);
int vision_ipc_arm_light_off(void);
int vision_ipc_arm_home(void);
int vision_ipc_place_unlock(int category);
int vision_ipc_place_lock(int category);
int vision_ipc_place_clear(int category);
int vision_ipc_place_show(void);

#ifdef __cplusplus
}
#endif

#endif /* VISION_IPC_TX_H */
