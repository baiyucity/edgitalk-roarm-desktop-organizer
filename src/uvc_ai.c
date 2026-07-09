#include <rtthread.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>

#ifdef RT_USING_FINSH
#include <finsh.h>
#endif

#include "uvc_ai.h"
#include "usb_config.h"

#undef USB_DBG_TAG
#define USB_DBG_TAG "uvc_ai"
#include "usb_log.h"

/*
 * V2.4 soft-range profile multi-object desk detector for Edgi-Talk M55 UVC demo.
 *
 * This version keeps the public uvc_ai_* interface, but changes the detector
 * from a dark-pen-only detector to:
 *   background difference -> connected components -> PCA long/short axis ->
 *   multi-class shape/size scoring with soft scale adaptation.
 *
 * First-stage classes:
 *   pen / eraser / cap / box / cosmetic
 *
 * Console commands:
 *   uvc_ai_bg_reset
 *   uvc_ai_bg_auto 0|1
 *   vadapt pen|eraser|cap|box|cosmetic
 *   vprof
 *   vclear [class|all]
 */

#define BG_DIFF_SAMPLE_STEP              2U
#define BG_WARMUP_FRAMES                 20U
#define BG_DIFF_THRESHOLD_BASE           24U
#define BG_DIFF_THRESHOLD_LOW            18U
#define BG_DIFF_THRESHOLD_MID            34U
#define BG_DIFF_THRESHOLD_HIGH           44U
#define BG_CHROMA_WEAK_THRESHOLD         18U
#define BG_CHROMA_STRONG_THRESHOLD       30U
#define BG_SCORE_WEAK_BASE               34U
#define BG_SCORE_STRONG_BASE             58U
#define BG_STABLE_UPDATE_THRESHOLD       8U
#define BG_MIN_CHANGED_PIXELS            24U
#define BG_LOG_INTERVAL_TICKS            (RT_TICK_PER_SECOND * 1U)

/* If too much of the scene changes, usually it is exposure/light/hand motion. */
#define BG_GLOBAL_CHANGE_X100            46U
#define BG_GLOBAL_HARD_CHANGE_X100       65U
#define BG_GLOBAL_LIGHT_SHIFT_Y          16

/* Slow background update during normal detection: bg = (63*bg + cur)/64. */
#define BG_EMA_NORMAL_SHIFT              6U
/* Faster adaptation only when global light changes: bg = (3*bg + cur)/4. */
#define BG_EMA_GLOBAL_SHIFT              2U

#define OBJ_MAX_COMPONENT_LABELS         256U
#define OBJ_MIN_PIXELS                   BG_MIN_CHANGED_PIXELS
#define OBJ_MIN_LONG_RAW                 12U
#define OBJ_MIN_SHORT_RAW                2U
#define OBJ_MAX_REGION_RATIO_X100        38U
#define OBJ_MAX_BOX_RATIO_X100           45U
#define OBJ_BBOX_MARGIN_RAW              4
#define OBJ_MIN_CLASS_SCORE              420U
#define OBJ_PROFILE_MIN_SCORE            620U

/* Noise suppression for desk-edge / paper-edge false positives. */
#define OBJ_BORDER_MARGIN_RAW            8
#define OBJ_LARGE_BOX_RATIO_X100         12U
#define OBJ_HUGE_BOX_RATIO_X100          22U
#define OBJ_LARGE_LOW_FILL_X100          24U
#define OBJ_HUGE_LOW_FILL_X100           34U
#define OBJ_PROFILE_MIN_SHAPE_SCORE      360U
#define OBJ_LINE_NOISE_SHORT_RAW         5U
#define OBJ_MIN_SOLID_FILL_X100          42U
#define OBJ_PEN_MIN_FILL_X100            6U
#define OBJ_MAX_FRAGMENT_MERGE_PASSES    3U

/* V15: stronger anti-fusion and solid-shape verification. */
#define OBJ_MERGE_MIN_UNION_ASPECT_X100   430U
#define OBJ_MERGE_MAX_GAP_RAW             8U
#define OBJ_FUSED_SPARSE_FILL_X100        38U
#define OBJ_BOX_STRICT_FILL_X100          66U
#define OBJ_CAP_MAX_AREA_RAW              520U
#define OBJ_COS_ROUND_MIN_AREA_RAW        560U
#define OBJ_COS_STICK_MIN_FILL_X100       34U

/* Live-frame contrast gate.
 * It suppresses "ghost" detections: if the object was part of the learned
 * background, removing it creates a foreground mask at the old location. In the
 * current frame that region is just desk/paper, so its color is almost the same
 * as the nearby ring. A real object keeps visible contrast against the ring. */
#define OBJ_LIVE_RING_MARGIN_RAW         14
#define OBJ_LIVE_MIN_FG_SAMPLES          6U
#define OBJ_LIVE_MIN_RING_SAMPLES        12U
#define OBJ_LIVE_GHOST_REJECT_SCORE      9U
#define OBJ_LIVE_WEAK_SCORE              13U
#define OBJ_LIVE_SOLID_SCORE             16U
#define BG_GHOST_HEAL_SHIFT              3U
#define BG_GHOST_HEAL_MIN_FG_FRAMES      4U

#define CLASS_PEN                        0U
#define CLASS_ERASER                     1U
#define CLASS_CAP                        2U
#define CLASS_BOX                        3U
#define CLASS_COSMETIC                   4U

static const char *g_class_names[UVC_AI_NUM_CLASSES] =
{
    "pen",
    "eraser",
    "cap",
    "box",
    "cosmetic"
};

static uint8_t  *g_bg_y = RT_NULL;
static uint8_t  *g_bg_u = RT_NULL;
static uint8_t  *g_bg_v = RT_NULL;
static uint8_t  *g_mask_seed = RT_NULL;
static uint8_t  *g_mask_a = RT_NULL;
static uint8_t  *g_mask_b = RT_NULL;
static uint16_t *g_label = RT_NULL;

static uint8_t  g_bg_valid;
static uint8_t  g_auto_background = 0U;
static uint16_t g_bg_warmup_count;
static uint16_t g_src_width;
static uint16_t g_src_height;
static uint16_t g_sample_w;
static uint16_t g_sample_h;
static uint32_t g_sample_pixels;
static rt_tick_t g_last_log_tick;
static uint32_t g_frame_index;
static uint16_t g_low_contrast_fg_frames;

static uint16_t g_cc_parent[OBJ_MAX_COMPONENT_LABELS];

/* Candidate/region statistics are kept in sample-space coordinates. */
typedef struct
{
    uint32_t count;
    uint32_t min_x;
    uint32_t min_y;
    uint32_t max_x;
    uint32_t max_y;
    uint64_t sum_x;
    uint64_t sum_y;
    uint64_t sum_xx;
    uint64_t sum_yy;
    uint64_t sum_xy;
} obj_candidate_t;

typedef struct
{
    uint8_t valid;
    uint8_t class_id;
    uint32_t score_u32;
    uint32_t count;
    uint16_t long_raw;
    uint16_t short_raw;
    uint16_t aspect_x100;
    uint16_t fill_x100;
    uint16_t live_contrast;
    uint16_t live_fg_samples;
    uint16_t live_ring_samples;
    uint16_t bbox_long_raw;
    uint16_t bbox_short_raw;
    uint16_t bbox_aspect_x100;
    uint32_t area_raw;
    int32_t raw_xmin;
    int32_t raw_ymin;
    int32_t raw_xmax;
    int32_t raw_ymax;
    float conf;
    char label[UVC_AI_MAX_CLASS_LEN];
} obj_detection_t;

typedef struct
{
    uint8_t enabled;
    uint16_t ref_long;
    uint16_t ref_short;
    uint16_t ref_aspect_x100;
    uint32_t ref_area;
    uint32_t update_count;
} obj_profile_t;

static obj_profile_t g_profiles[UVC_AI_NUM_CLASSES];
static obj_detection_t g_last_candidates[UVC_AI_MAX_PREDICTIONS];
static uint8_t g_last_candidate_count;

static inline uint8_t bg_abs_diff_u8(uint8_t a, uint8_t b)
{
    return (a > b) ? (uint8_t)(a - b) : (uint8_t)(b - a);
}

static inline int16_t bg_clamp_i16(int32_t value, int32_t min_v, int32_t max_v)
{
    if (value < min_v) value = min_v;
    if (value > max_v) value = max_v;
    return (int16_t)value;
}

static float obj_sqrtf(float x)
{
    float y;
    uint8_t i;
    if (x <= 0.0f) return 0.0f;
    y = (x > 1.0f) ? x : 1.0f;
    for (i = 0U; i < 8U; i++)
    {
        y = 0.5f * (y + x / y);
    }
    return y;
}

static inline void bg_get_yuv_sample(const uint8_t *yuyv, uint32_t sx, uint32_t sy,
                                     uint8_t *out_y, uint8_t *out_u, uint8_t *out_v)
{
    uint32_t x = sx * BG_DIFF_SAMPLE_STEP;
    uint32_t y = sy * BG_DIFF_SAMPLE_STEP;
    uint32_t pair_x = x & ~1UL;
    uint32_t byte_index = (y * (uint32_t)g_src_width * 2U) + (pair_x * 2U);

    if (out_y != RT_NULL)
    {
        uint32_t y_index = (y * (uint32_t)g_src_width * 2U) + (x * 2U);
        *out_y = yuyv[y_index];
    }
    if (out_u != RT_NULL) *out_u = yuyv[byte_index + 1U];
    if (out_v != RT_NULL) *out_v = yuyv[byte_index + 3U];
}

static inline uint8_t bg_get_y_sample(const uint8_t *yuyv, uint32_t sx, uint32_t sy)
{
    uint8_t y;
    bg_get_yuv_sample(yuyv, sx, sy, &y, RT_NULL, RT_NULL);
    return y;
}

static inline uint16_t bg_yuv_diff_score(uint8_t cur_y, uint8_t cur_u, uint8_t cur_v,
                                         uint8_t old_y, uint8_t old_u, uint8_t old_v,
                                         uint8_t *dy_out, uint8_t *chroma_out)
{
    uint8_t dy = bg_abs_diff_u8(cur_y, old_y);
    uint8_t du = bg_abs_diff_u8(cur_u, old_u);
    uint8_t dv = bg_abs_diff_u8(cur_v, old_v);
    uint16_t chroma = (uint16_t)du + (uint16_t)dv;
    if (dy_out != RT_NULL) *dy_out = dy;
    if (chroma_out != RT_NULL) *chroma_out = (chroma > 255U) ? 255U : (uint8_t)chroma;

    /* Luma still matters for black pens; chroma helps transparent/red/blue shells. */
    return (uint16_t)dy + (uint16_t)((chroma * 3U) / 4U);
}

static inline int16_t bg_map_x_to_ai(int32_t raw_x)
{
    int32_t x;
    if (g_src_width == 0U) return 0;
    x = (raw_x * (int32_t)UVC_AI_IMAGE_WIDTH) / (int32_t)g_src_width;
    return bg_clamp_i16(x, 0, (int32_t)UVC_AI_IMAGE_WIDTH - 1);
}

static inline int16_t bg_map_y_to_ai(int32_t raw_y)
{
    int32_t y;
    if (g_src_height == 0U) return 0;
    y = (raw_y * (int32_t)UVC_AI_IMAGE_HEIGHT) / (int32_t)g_src_height;
    return bg_clamp_i16(y, 0, (int32_t)UVC_AI_IMAGE_HEIGHT - 1);
}

static void obj_candidate_reset(obj_candidate_t *c)
{
    if (c == RT_NULL) return;
    memset(c, 0, sizeof(*c));
    c->min_x = 0xFFFFFFFFUL;
    c->min_y = 0xFFFFFFFFUL;
}

static void obj_candidate_add(obj_candidate_t *c, uint32_t sx, uint32_t sy)
{
    if (c == RT_NULL) return;
    c->count++;
    if (sx < c->min_x) c->min_x = sx;
    if (sy < c->min_y) c->min_y = sy;
    if (sx > c->max_x) c->max_x = sx;
    if (sy > c->max_y) c->max_y = sy;
    c->sum_x += sx;
    c->sum_y += sy;
    c->sum_xx += (uint64_t)sx * (uint64_t)sx;
    c->sum_yy += (uint64_t)sy * (uint64_t)sy;
    c->sum_xy += (uint64_t)sx * (uint64_t)sy;
}

static void bg_free_buffer(void)
{
    if (g_bg_y != RT_NULL)
    {
        rt_free(g_bg_y);
        g_bg_y = RT_NULL;
    }
    if (g_bg_u != RT_NULL)
    {
        rt_free(g_bg_u);
        g_bg_u = RT_NULL;
    }
    if (g_bg_v != RT_NULL)
    {
        rt_free(g_bg_v);
        g_bg_v = RT_NULL;
    }
    if (g_mask_seed != RT_NULL)
    {
        rt_free(g_mask_seed);
        g_mask_seed = RT_NULL;
    }
    if (g_mask_a != RT_NULL)
    {
        rt_free(g_mask_a);
        g_mask_a = RT_NULL;
    }
    if (g_mask_b != RT_NULL)
    {
        rt_free(g_mask_b);
        g_mask_b = RT_NULL;
    }
    if (g_label != RT_NULL)
    {
        rt_free(g_label);
        g_label = RT_NULL;
    }
}

static int bg_alloc_buffer(uint16_t width, uint16_t height)
{
    bg_free_buffer();

    g_src_width = width;
    g_src_height = height;
    g_sample_w = (uint16_t)(g_src_width / BG_DIFF_SAMPLE_STEP);
    g_sample_h = (uint16_t)(g_src_height / BG_DIFF_SAMPLE_STEP);

    if ((g_sample_w == 0U) || (g_sample_h == 0U))
    {
        USB_LOG_ERR("invalid detector size: %ux%u\r\n", (unsigned)width, (unsigned)height);
        return -RT_EINVAL;
    }

    g_sample_pixels = (uint32_t)g_sample_w * (uint32_t)g_sample_h;

    g_bg_y = (uint8_t *)rt_malloc(g_sample_pixels);
    g_bg_u = (uint8_t *)rt_malloc(g_sample_pixels);
    g_bg_v = (uint8_t *)rt_malloc(g_sample_pixels);
    g_mask_seed = (uint8_t *)rt_malloc(g_sample_pixels);
    g_mask_a = (uint8_t *)rt_malloc(g_sample_pixels);
    g_mask_b = (uint8_t *)rt_malloc(g_sample_pixels);
    g_label = (uint16_t *)rt_malloc(g_sample_pixels * sizeof(uint16_t));

    if ((g_bg_y == RT_NULL) || (g_bg_u == RT_NULL) || (g_bg_v == RT_NULL) ||
        (g_mask_seed == RT_NULL) || (g_mask_a == RT_NULL) ||
        (g_mask_b == RT_NULL) || (g_label == RT_NULL))
    {
        USB_LOG_ERR("detector malloc failed: samples=%lu\r\n", (unsigned long)g_sample_pixels);
        bg_free_buffer();
        return -RT_ENOMEM;
    }

    memset(g_bg_y, 0, g_sample_pixels);
    memset(g_bg_u, 128, g_sample_pixels);
    memset(g_bg_v, 128, g_sample_pixels);
    memset(g_mask_seed, 0, g_sample_pixels);
    memset(g_mask_a, 0, g_sample_pixels);
    memset(g_mask_seed, 0, g_sample_pixels);
    memset(g_mask_b, 0, g_sample_pixels);
    memset(g_label, 0, g_sample_pixels * sizeof(uint16_t));
    return RT_EOK;
}

static void bg_reset_state(void)
{
    g_bg_valid = 0U;
    g_bg_warmup_count = 0U;
    g_frame_index = 0U;
    g_last_candidate_count = 0U;
    g_low_contrast_fg_frames = 0U;
    memset(g_last_candidates, 0, sizeof(g_last_candidates));
    if (g_bg_y != RT_NULL)
    {
        memset(g_bg_y, 0, g_sample_pixels);
    }
    if (g_bg_u != RT_NULL)
    {
        memset(g_bg_u, 128, g_sample_pixels);
    }
    if (g_bg_v != RT_NULL)
    {
        memset(g_bg_v, 128, g_sample_pixels);
    }
    if (g_mask_seed != RT_NULL)
    {
        memset(g_mask_seed, 0, g_sample_pixels);
    }
    USB_LOG_INFO("background reset; keep desk clean for calibration\r\n");
}

void uvc_ai_force_bg_reset(void)
{
    bg_reset_state();
}

void uvc_ai_set_auto_background(uint8_t enable)
{
    g_auto_background = enable ? 1U : 0U;
    USB_LOG_INFO("auto background update: %s\r\n", g_auto_background ? "on" : "off");
}

void uvc_ai_set_auto_bg(uint8_t enable)
{
    uvc_ai_set_auto_background(enable);
}

static void bg_learn_frame(const uint8_t *yuyv)
{
    uint32_t sx, sy, idx = 0U;

    for (sy = 0U; sy < g_sample_h; sy++)
    {
        for (sx = 0U; sx < g_sample_w; sx++)
        {
            uint8_t y, u, v;
            bg_get_yuv_sample(yuyv, sx, sy, &y, &u, &v);
            if (g_bg_warmup_count == 0U)
            {
                g_bg_y[idx] = y;
                g_bg_u[idx] = u;
                g_bg_v[idx] = v;
            }
            else
            {
                g_bg_y[idx] = (uint8_t)(((uint16_t)g_bg_y[idx] * 7U + (uint16_t)y) / 8U);
                g_bg_u[idx] = (uint8_t)(((uint16_t)g_bg_u[idx] * 7U + (uint16_t)u) / 8U);
                g_bg_v[idx] = (uint8_t)(((uint16_t)g_bg_v[idx] * 7U + (uint16_t)v) / 8U);
            }
            idx++;
        }
    }

    if (g_bg_warmup_count < BG_WARMUP_FRAMES) g_bg_warmup_count++;

    if (g_bg_warmup_count >= BG_WARMUP_FRAMES)
    {
        g_bg_valid = 1U;
        USB_LOG_INFO("background ready: src=%ux%u samples=%ux%u auto_bg=%u\r\n",
                     (unsigned)g_src_width, (unsigned)g_src_height,
                     (unsigned)g_sample_w, (unsigned)g_sample_h,
                     (unsigned)g_auto_background);
    }
}

static void bg_blend_global_frame(const uint8_t *yuyv)
{
    uint32_t sx, sy, idx = 0U;

    if (!g_auto_background) return;

    for (sy = 0U; sy < g_sample_h; sy++)
    {
        for (sx = 0U; sx < g_sample_w; sx++)
        {
            uint8_t cur_y, cur_u, cur_v;
            bg_get_yuv_sample(yuyv, sx, sy, &cur_y, &cur_u, &cur_v);
            g_bg_y[idx] = (uint8_t)(((uint16_t)g_bg_y[idx] * ((1U << BG_EMA_GLOBAL_SHIFT) - 1U) +
                                     (uint16_t)cur_y) >> BG_EMA_GLOBAL_SHIFT);
            g_bg_u[idx] = (uint8_t)(((uint16_t)g_bg_u[idx] * ((1U << BG_EMA_GLOBAL_SHIFT) - 1U) +
                                     (uint16_t)cur_u) >> BG_EMA_GLOBAL_SHIFT);
            g_bg_v[idx] = (uint8_t)(((uint16_t)g_bg_v[idx] * ((1U << BG_EMA_GLOBAL_SHIFT) - 1U) +
                                     (uint16_t)cur_v) >> BG_EMA_GLOBAL_SHIFT);
            idx++;
        }
    }
}

static uint8_t bg_dynamic_diff_threshold(uint32_t rough_changed)
{
    uint32_t ratio_x100;
    if (g_sample_pixels == 0U) return BG_DIFF_THRESHOLD_BASE;

    ratio_x100 = (rough_changed * 100U) / g_sample_pixels;
    if (ratio_x100 > 35U) return BG_DIFF_THRESHOLD_HIGH;
    if (ratio_x100 > 20U) return BG_DIFF_THRESHOLD_MID;
    if (ratio_x100 < 5U)  return BG_DIFF_THRESHOLD_LOW;
    return BG_DIFF_THRESHOLD_BASE;
}

void uvc_ai_reset_result(uvc_ai_result_t *result)
{
    if (result == RT_NULL) return;
    memset(result, 0, sizeof(*result));
}

int uvc_ai_init(const uvc_ai_config_t *config)
{
    uint16_t width = UVC_AI_CAMERA_WIDTH;
    uint16_t height = UVC_AI_CAMERA_HEIGHT;
    int ret;

    if (config != RT_NULL)
    {
        if (config->src_width != 0U) width = config->src_width;
        if (config->src_height != 0U) height = config->src_height;
    }

    ret = bg_alloc_buffer(width, height);
    if (ret != RT_EOK) return ret;

    bg_reset_state();
    g_last_log_tick = 0U;

    USB_LOG_INFO("V2.4 profile-range multi-object detector initialized, src=%ux%u, output=%ux%u\r\n",
                 (unsigned)g_src_width, (unsigned)g_src_height,
                 (unsigned)UVC_AI_IMAGE_WIDTH, (unsigned)UVC_AI_IMAGE_HEIGHT);
    USB_LOG_INFO("noise filter: color-aware bgdiff + live contrast ghost gate + widened soft profile probability scoring enabled\r\n");
    return RT_EOK;
}

void uvc_ai_deinit(void)
{
    bg_reset_state();
    bg_free_buffer();
    USB_LOG_INFO("V2.4 profile-range multi-object detector deinitialized\r\n");
}

static uint16_t cc_find(uint16_t x)
{
    uint16_t p;
    if ((x == 0U) || (x >= OBJ_MAX_COMPONENT_LABELS)) return 0U;
    p = g_cc_parent[x];
    while ((p != 0U) && (p != g_cc_parent[p]))
    {
        g_cc_parent[p] = g_cc_parent[g_cc_parent[p]];
        p = g_cc_parent[p];
    }
    return p;
}

static void cc_union(uint16_t a, uint16_t b)
{
    uint16_t ra = cc_find(a);
    uint16_t rb = cc_find(b);
    if ((ra == 0U) || (rb == 0U) || (ra == rb)) return;
    if (ra < rb) g_cc_parent[rb] = ra;
    else g_cc_parent[ra] = rb;
}

static void clean_mask_seeded_3x3(const uint8_t *weak, const uint8_t *strong, uint8_t *dst)
{
    uint32_t sx, sy;
    memset(dst, 0, g_sample_pixels);

    if ((weak == RT_NULL) || (strong == RT_NULL) || (dst == RT_NULL)) return;
    if ((g_sample_w < 3U) || (g_sample_h < 3U)) return;

    for (sy = 1U; sy < (uint32_t)g_sample_h - 1U; sy++)
    {
        for (sx = 1U; sx < (uint32_t)g_sample_w - 1U; sx++)
        {
            uint32_t idx = sy * (uint32_t)g_sample_w + sx;
            uint8_t weak_n = 0U;
            uint8_t strong_n = 0U;

            if (weak[idx] == 0U) continue;

            weak_n += weak[idx - 1U] ? 1U : 0U;
            weak_n += weak[idx + 1U] ? 1U : 0U;
            weak_n += weak[idx - (uint32_t)g_sample_w] ? 1U : 0U;
            weak_n += weak[idx + (uint32_t)g_sample_w] ? 1U : 0U;
            weak_n += weak[idx - (uint32_t)g_sample_w - 1U] ? 1U : 0U;
            weak_n += weak[idx - (uint32_t)g_sample_w + 1U] ? 1U : 0U;
            weak_n += weak[idx + (uint32_t)g_sample_w - 1U] ? 1U : 0U;
            weak_n += weak[idx + (uint32_t)g_sample_w + 1U] ? 1U : 0U;

            strong_n += strong[idx] ? 1U : 0U;
            strong_n += strong[idx - 1U] ? 1U : 0U;
            strong_n += strong[idx + 1U] ? 1U : 0U;
            strong_n += strong[idx - (uint32_t)g_sample_w] ? 1U : 0U;
            strong_n += strong[idx + (uint32_t)g_sample_w] ? 1U : 0U;
            strong_n += strong[idx - (uint32_t)g_sample_w - 1U] ? 1U : 0U;
            strong_n += strong[idx - (uint32_t)g_sample_w + 1U] ? 1U : 0U;
            strong_n += strong[idx + (uint32_t)g_sample_w - 1U] ? 1U : 0U;
            strong_n += strong[idx + (uint32_t)g_sample_w + 1U] ? 1U : 0U;

            /* Keep strong-core pixels and weak pixels attached to a real object.
             * Isolated notebook lines usually have weak_n around 1-2 and no strong seed. */
            if ((strong_n > 0U) || (weak_n >= 4U))
            {
                dst[idx] = 1U;
            }
        }
    }
}

static void bridge_small_orthogonal_gaps(uint8_t *mask)
{
    uint32_t sx, sy;
    if ((mask == RT_NULL) || (g_sample_w < 5U) || (g_sample_h < 5U)) return;

    memset(g_mask_a, 0, g_sample_pixels);
    memcpy(g_mask_a, mask, g_sample_pixels);

    for (sy = 2U; sy < (uint32_t)g_sample_h - 2U; sy++)
    {
        for (sx = 2U; sx < (uint32_t)g_sample_w - 2U; sx++)
        {
            uint32_t idx = sy * (uint32_t)g_sample_w + sx;
            if (g_mask_a[idx]) continue;

            /* Fill only very small gaps inside already detected strokes. */
            if ((g_mask_a[idx - 1U] && g_mask_a[idx + 1U]) ||
                (g_mask_a[idx - 2U] && g_mask_a[idx + 1U]) ||
                (g_mask_a[idx - 1U] && g_mask_a[idx + 2U]) ||
                (g_mask_a[idx - (uint32_t)g_sample_w] && g_mask_a[idx + (uint32_t)g_sample_w]) ||
                (g_mask_a[idx - 2U * (uint32_t)g_sample_w] && g_mask_a[idx + (uint32_t)g_sample_w]) ||
                (g_mask_a[idx - (uint32_t)g_sample_w] && g_mask_a[idx + 2U * (uint32_t)g_sample_w]))
            {
                mask[idx] = 1U;
            }
        }
    }
}

static uint16_t cc_label_mask(const uint8_t *mask)
{
    uint32_t sx, sy;
    uint16_t label_count = 0U;
    uint32_t i;

    memset(g_label, 0, g_sample_pixels * sizeof(uint16_t));
    memset(g_cc_parent, 0, sizeof(g_cc_parent));

    for (i = 1U; i < OBJ_MAX_COMPONENT_LABELS; i++)
    {
        g_cc_parent[i] = (uint16_t)i;
    }

    for (sy = 0U; sy < g_sample_h; sy++)
    {
        for (sx = 0U; sx < g_sample_w; sx++)
        {
            uint32_t idx = sy * (uint32_t)g_sample_w + sx;
            uint16_t left = 0U;
            uint16_t up = 0U;
            uint16_t lab = 0U;

            if (mask[idx] == 0U) continue;

            if (sx > 0U) left = g_label[idx - 1U];
            if (sy > 0U) up = g_label[idx - (uint32_t)g_sample_w];

            if ((left == 0U) && (up == 0U))
            {
                if ((uint32_t)label_count + 1U < OBJ_MAX_COMPONENT_LABELS)
                {
                    label_count++;
                    lab = label_count;
                    g_cc_parent[lab] = lab;
                }
                else
                {
                    lab = 0U;
                }
            }
            else if (left != 0U)
            {
                lab = cc_find(left);
                if (up != 0U) cc_union(left, up);
            }
            else
            {
                lab = cc_find(up);
            }

            g_label[idx] = lab;
        }
    }

    return label_count;
}

static uint32_t rel_closeness_score_u32(uint32_t value, uint32_t ref, uint32_t tol_x100)
{
    uint32_t diff;
    uint32_t err_x100;
    if (ref == 0U) return 0U;
    diff = (value > ref) ? (value - ref) : (ref - value);
    err_x100 = (diff * 100U) / ref;
    if (err_x100 >= tol_x100) return 0U;
    return 1000U - ((err_x100 * 1000U) / tol_x100);
}

static uint8_t any_profile_enabled(void)
{
    uint8_t i;
    for (i = 0U; i < UVC_AI_NUM_CLASSES; i++)
    {
        if (g_profiles[i].enabled) return 1U;
    }
    return 0U;
}

static inline uint16_t obj_effective_long_raw(const obj_detection_t *d)
{
    uint16_t l;
    if (d == RT_NULL) return 0U;
    l = d->long_raw;
    if (d->bbox_long_raw > l) l = d->bbox_long_raw;
    return l;
}

static inline uint16_t obj_effective_short_raw(const obj_detection_t *d)
{
    uint16_t s;
    if (d == RT_NULL) return 0U;
    s = d->short_raw;
    if ((d->bbox_short_raw > s) && (d->bbox_short_raw < (uint16_t)(s * 3U))) s = d->bbox_short_raw;
    return s;
}

static uint8_t obj_is_line_noise(const obj_detection_t *d)
{
    uint16_t l;
    if ((d == RT_NULL) || !d->valid) return 0U;
    l = obj_effective_long_raw(d);

    if ((d->short_raw <= OBJ_LINE_NOISE_SHORT_RAW) &&
        (d->fill_x100 <= 18U) &&
        (d->area_raw < ((uint32_t)l * 5U)))
    {
        return 1U;
    }

    if ((g_src_width != 0U) && (l > ((uint32_t)g_src_width * 85U) / 100U) &&
        (d->short_raw <= 10U))
    {
        return 1U;
    }

    return 0U;
}


static uint16_t obj_live_contrast_from_current_frame(const uint8_t *yuyv, const uint8_t *mask,
                                                     const obj_detection_t *d,
                                                     uint16_t *fg_count_out,
                                                     uint16_t *ring_count_out)
{
    int32_t sx0, sy0, sx1, sy1;
    int32_t ex0, ey0, ex1, ey1;
    int32_t sx, sy;
    uint32_t fg_count = 0U;
    uint32_t ring_count = 0U;
    uint32_t fg_y = 0U, fg_u = 0U, fg_v = 0U;
    uint32_t ring_y = 0U, ring_u = 0U, ring_v = 0U;
    uint8_t avg_fy, avg_fu, avg_fv, avg_ry, avg_ru, avg_rv, dy, chroma;
    uint16_t score;

    if (fg_count_out != RT_NULL) *fg_count_out = 0U;
    if (ring_count_out != RT_NULL) *ring_count_out = 0U;
    if ((yuyv == RT_NULL) || (mask == RT_NULL) || (d == RT_NULL) || !d->valid) return 0U;
    if ((g_sample_w == 0U) || (g_sample_h == 0U)) return 0U;

    sx0 = d->raw_xmin / (int32_t)BG_DIFF_SAMPLE_STEP;
    sy0 = d->raw_ymin / (int32_t)BG_DIFF_SAMPLE_STEP;
    sx1 = d->raw_xmax / (int32_t)BG_DIFF_SAMPLE_STEP;
    sy1 = d->raw_ymax / (int32_t)BG_DIFF_SAMPLE_STEP;

    ex0 = (d->raw_xmin - OBJ_LIVE_RING_MARGIN_RAW) / (int32_t)BG_DIFF_SAMPLE_STEP;
    ey0 = (d->raw_ymin - OBJ_LIVE_RING_MARGIN_RAW) / (int32_t)BG_DIFF_SAMPLE_STEP;
    ex1 = (d->raw_xmax + OBJ_LIVE_RING_MARGIN_RAW) / (int32_t)BG_DIFF_SAMPLE_STEP;
    ey1 = (d->raw_ymax + OBJ_LIVE_RING_MARGIN_RAW) / (int32_t)BG_DIFF_SAMPLE_STEP;

    if (sx0 < 0) sx0 = 0;
    if (sy0 < 0) sy0 = 0;
    if (sx1 >= (int32_t)g_sample_w) sx1 = (int32_t)g_sample_w - 1;
    if (sy1 >= (int32_t)g_sample_h) sy1 = (int32_t)g_sample_h - 1;
    if (ex0 < 0) ex0 = 0;
    if (ey0 < 0) ey0 = 0;
    if (ex1 >= (int32_t)g_sample_w) ex1 = (int32_t)g_sample_w - 1;
    if (ey1 >= (int32_t)g_sample_h) ey1 = (int32_t)g_sample_h - 1;

    for (sy = sy0; sy <= sy1; sy++)
    {
        for (sx = sx0; sx <= sx1; sx++)
        {
            uint32_t idx = (uint32_t)sy * (uint32_t)g_sample_w + (uint32_t)sx;
            uint8_t y, u, v;
            if (mask[idx] == 0U) continue;
            bg_get_yuv_sample(yuyv, (uint32_t)sx, (uint32_t)sy, &y, &u, &v);
            fg_y += y;
            fg_u += u;
            fg_v += v;
            fg_count++;
        }
    }

    for (sy = ey0; sy <= ey1; sy++)
    {
        for (sx = ex0; sx <= ex1; sx++)
        {
            uint8_t y, u, v;
            if ((sx >= sx0) && (sx <= sx1) && (sy >= sy0) && (sy <= sy1)) continue;
            bg_get_yuv_sample(yuyv, (uint32_t)sx, (uint32_t)sy, &y, &u, &v);
            ring_y += y;
            ring_u += u;
            ring_v += v;
            ring_count++;
        }
    }

    if (fg_count_out != RT_NULL) *fg_count_out = (fg_count > 65535U) ? 65535U : (uint16_t)fg_count;
    if (ring_count_out != RT_NULL) *ring_count_out = (ring_count > 65535U) ? 65535U : (uint16_t)ring_count;

    if ((fg_count < OBJ_LIVE_MIN_FG_SAMPLES) || (ring_count < OBJ_LIVE_MIN_RING_SAMPLES)) return 0U;

    avg_fy = (uint8_t)(fg_y / fg_count);
    avg_fu = (uint8_t)(fg_u / fg_count);
    avg_fv = (uint8_t)(fg_v / fg_count);
    avg_ry = (uint8_t)(ring_y / ring_count);
    avg_ru = (uint8_t)(ring_u / ring_count);
    avg_rv = (uint8_t)(ring_v / ring_count);

    score = bg_yuv_diff_score(avg_fy, avg_fu, avg_fv, avg_ry, avg_ru, avg_rv, &dy, &chroma);
    if (score > 255U) score = 255U;
    return score;
}

static void bg_heal_mask_pixels(const uint8_t *yuyv, const uint8_t *mask)
{
    uint32_t idx = 0U;
    uint32_t sx, sy;
    if ((yuyv == RT_NULL) || (mask == RT_NULL) || (g_bg_y == RT_NULL)) return;

    for (sy = 0U; sy < g_sample_h; sy++)
    {
        for (sx = 0U; sx < g_sample_w; sx++)
        {
            if (mask[idx] != 0U)
            {
                uint8_t cur_y, cur_u, cur_v;
                bg_get_yuv_sample(yuyv, sx, sy, &cur_y, &cur_u, &cur_v);
                g_bg_y[idx] = (uint8_t)(((uint16_t)g_bg_y[idx] * ((1U << BG_GHOST_HEAL_SHIFT) - 1U) +
                                         (uint16_t)cur_y) >> BG_GHOST_HEAL_SHIFT);
                g_bg_u[idx] = (uint8_t)(((uint16_t)g_bg_u[idx] * ((1U << BG_GHOST_HEAL_SHIFT) - 1U) +
                                         (uint16_t)cur_u) >> BG_GHOST_HEAL_SHIFT);
                g_bg_v[idx] = (uint8_t)(((uint16_t)g_bg_v[idx] * ((1U << BG_GHOST_HEAL_SHIFT) - 1U) +
                                         (uint16_t)cur_v) >> BG_GHOST_HEAL_SHIFT);
            }
            idx++;
        }
    }
}

static uint8_t obj_is_sparse_fused_nonpen(const obj_detection_t *d)
{
    uint16_t a;
    uint16_t s;

    if ((d == RT_NULL) || !d->valid) return 0U;
    a = d->aspect_x100;
    if (a < d->bbox_aspect_x100) a = d->bbox_aspect_x100;
    s = obj_effective_short_raw(d);

    /* When two nearby objects are fused by background difference, the union is
     * usually a large, sparse component. Do not let that become box/cosmetic.
     * Pens remain allowed because transparent/hollow pens naturally have low fill. */
    if ((d->fill_x100 < OBJ_FUSED_SPARSE_FILL_X100) &&
        (d->area_raw >= 360U) &&
        (s >= 12U) &&
        (a <= 760U))
    {
        return 1U;
    }
    return 0U;
}

static uint32_t class_shape_score(uint8_t cls, const obj_detection_t *d)
{
    uint16_t a;
    uint16_t f;
    uint16_t l;
    uint16_t s;
    uint16_t ba;

    if ((d == RT_NULL) || !d->valid) return 0U;
    if (obj_is_line_noise(d)) return 0U;
    if (d->live_contrast < OBJ_LIVE_GHOST_REJECT_SCORE) return 0U;

    a = d->aspect_x100;
    f = d->fill_x100;
    l = obj_effective_long_raw(d);
    s = obj_effective_short_raw(d);
    ba = d->bbox_aspect_x100;
    if (a < ba) a = ba;

    switch (cls)
    {
    case CLASS_PEN:
        /* Pens may be transparent/hollow and may contain separated ink blocks.
         * Very high aspect candidates are deliberately biased to pen so that
         * stacked/overlapping pens do not drift into cosmetic. */
        if ((a >= 700U) && (l >= 70U) && (s <= 30U) && (f >= OBJ_PEN_MIN_FILL_X100)) return 1040U;
        if ((a >= 520U) && (l >= 70U) && (s <= 32U) && (f >= OBJ_PEN_MIN_FILL_X100)) return 980U;
        if ((a >= 380U) && (l >= 55U) && (s <= 36U) && (f >= OBJ_PEN_MIN_FILL_X100)) return 780U;
        if ((a >= 300U) && (l >= 45U) && (s <= 42U) && (f >= 10U)) return 540U;
        return 0U;

    case CLASS_ERASER:
        if (d->live_contrast < OBJ_LIVE_WEAK_SCORE) return 0U;
        if (obj_is_sparse_fused_nonpen(d)) return 0U;
        /* Eraser must be a short, solid rectangular/block-like component. */
        if ((a >= 105U) && (a <= 270U) && (f >= 58U) &&
            (d->area_raw >= 260U) && (d->area_raw <= 1700U) &&
            (l <= 125U) && (s >= 12U)) return 920U;
        if ((a >= 95U) && (a <= 300U) && (f >= 52U) &&
            (d->area_raw >= 220U) && (d->area_raw <= 2000U) &&
            (l <= 140U) && (s >= 10U)) return 620U;
        return 0U;

    case CLASS_CAP:
        if (d->live_contrast < OBJ_LIVE_WEAK_SCORE) return 0U;
        if (obj_is_sparse_fused_nonpen(d)) return 0U;
        /* Bottle caps must be round/square and solid. Larger round cosmetics are
         * handled by CLASS_COSMETIC, not cap. */
        if ((a >= 82U) && (a <= 128U) && (f >= 58U) &&
            (l <= 90U) && (s >= 10U) &&
            (d->area_raw >= 120U) && (d->area_raw <= OBJ_CAP_MAX_AREA_RAW)) return 940U;
        if ((a >= 75U) && (a <= 145U) && (f >= 52U) &&
            (l <= 105U) && (s >= 8U) &&
            (d->area_raw >= 90U) && (d->area_raw <= (OBJ_CAP_MAX_AREA_RAW + 180U))) return 650U;
        return 0U;

    case CLASS_BOX:
        if (d->live_contrast < OBJ_LIVE_SOLID_SCORE) return 0U;
        if (obj_is_sparse_fused_nonpen(d)) return 0U;
        /* A box is treated as a truly solid rectangle. No diagonal/union proof:
         * high fill and reasonable aspect are required. */
        if ((a >= 85U) && (a <= 240U) && (f >= OBJ_BOX_STRICT_FILL_X100) &&
            (d->area_raw >= 900U) && (s >= 22U)) return 920U;
        if ((a >= 75U) && (a <= 280U) && (f >= 60U) &&
            (d->area_raw >= 700U) && (s >= 18U)) return 660U;
        return 0U;

    case CLASS_COSMETIC:
        if (d->live_contrast < OBJ_LIVE_WEAK_SCORE) return 0U;

        /* 1) very slim makeup pencil / eyebrow pencil. Without a cosmetic profile,
         * pen keeps priority; with a profile, this can be boosted by vadapt. */
        if ((a >= 650U) && (l >= 55U) && (s <= 26U) && (f >= OBJ_PEN_MIN_FILL_X100)) return 720U;

        if (obj_is_sparse_fused_nonpen(d)) return 0U;

        /* 2) lipstick / mascara / short stick: longer than eraser, thicker than pen, solid. */
        if ((a >= 210U) && (a <= 520U) && (l >= 45U) && (l <= 180U) &&
            (s >= 12U) && (s <= 48U) && (f >= OBJ_COS_STICK_MIN_FILL_X100)) return 820U;
        if ((a >= 160U) && (a <= 600U) && (l >= 38U) && (l <= 190U) &&
            (s >= 10U) && (f >= 30U)) return 560U;

        /* 3) compact / powder puff: round, bigger than a cap, and solid. */
        if ((a >= 80U) && (a <= 140U) && (f >= 58U) &&
            (d->area_raw >= OBJ_COS_ROUND_MIN_AREA_RAW) &&
            (l >= 32U) && (s >= 24U)) return 790U;
        return 0U;

    default:
        return 0U;
    }
}

static uint8_t obj_touches_image_border(const obj_detection_t *d)
{
    if ((d == RT_NULL) || (g_src_width == 0U) || (g_src_height == 0U)) return 0U;

    if ((d->raw_xmin <= OBJ_BORDER_MARGIN_RAW) ||
        (d->raw_ymin <= OBJ_BORDER_MARGIN_RAW) ||
        (d->raw_xmax >= ((int32_t)g_src_width - 1 - OBJ_BORDER_MARGIN_RAW)) ||
        (d->raw_ymax >= ((int32_t)g_src_height - 1 - OBJ_BORDER_MARGIN_RAW)))
    {
        return 1U;
    }
    return 0U;
}

static uint8_t obj_is_large_sparse_noise(const obj_detection_t *d)
{
    uint32_t raw_box_w;
    uint32_t raw_box_h;
    uint32_t raw_box_area;
    uint32_t frame_area;
    uint32_t box_ratio_x100;

    if ((d == RT_NULL) || !d->valid || (g_src_width == 0U) || (g_src_height == 0U)) return 0U;
    if ((d->raw_xmax <= d->raw_xmin) || (d->raw_ymax <= d->raw_ymin)) return 0U;

    raw_box_w = (uint32_t)(d->raw_xmax - d->raw_xmin + 1);
    raw_box_h = (uint32_t)(d->raw_ymax - d->raw_ymin + 1);
    raw_box_area = raw_box_w * raw_box_h;
    frame_area = (uint32_t)g_src_width * (uint32_t)g_src_height;
    if (frame_area == 0U) return 0U;

    box_ratio_x100 = (raw_box_area * 100U) / frame_area;

    /* Big sparse components at image borders are usually paper/table/light edges. */
    if (obj_touches_image_border(d) &&
        (box_ratio_x100 >= OBJ_LARGE_BOX_RATIO_X100) &&
        (d->fill_x100 <= OBJ_LARGE_LOW_FILL_X100))
    {
        return 1U;
    }

    /* Huge low-fill boxes are nearly always background regions, not a real object. */
    if ((box_ratio_x100 >= OBJ_HUGE_BOX_RATIO_X100) &&
        (d->fill_x100 <= OBJ_HUGE_LOW_FILL_X100))
    {
        return 1U;
    }

    return 0U;
}

static uint32_t profile_soft_bonus(uint8_t cls, const obj_detection_t *d)
{
    uint32_t long_s, short_s, area_s, aspect_s;
    uint32_t prof_s;
    uint32_t tol_long = 100U;
    uint32_t tol_short = 105U;
    uint32_t tol_area = 170U;
    uint32_t tol_aspect = 95U;

    if ((d == RT_NULL) || (cls >= UVC_AI_NUM_CLASSES) || (!g_profiles[cls].enabled)) return 0U;

    /* V16: vadapt remains a soft probability reference, not a hard lock.
     * The tolerance is deliberately wider than V15, especially for pen/eraser:
     *   - same-category objects with slightly different physical sizes can pass;
     *   - the closeness score still decays with size error, so probability is
     *     higher when long/short/area/aspect are closer to the learned sample. */
    if (cls == CLASS_CAP)
    {
        tol_long = 95U;
        tol_short = 95U;
        tol_area = 165U;
        tol_aspect = 80U;
    }
    else if (cls == CLASS_ERASER)
    {
        /* Erasers vary a lot in brand/thickness; keep shape validation strict
         * but allow a larger learned-size window. */
        tol_long = 130U;
        tol_short = 140U;
        tol_area = 240U;
        tol_aspect = 120U;
    }
    else if (cls == CLASS_BOX)
    {
        tol_long = 105U;
        tol_short = 115U;
        tol_area = 185U;
        tol_aspect = 95U;
    }
    else if (cls == CLASS_PEN)
    {
        /* Pens can be capped/uncapped, transparent, thick gel pens, etc.
         * Long/short/area tolerance is widened, but aspect still contributes
         * strongly to probability. */
        tol_long = 150U;
        tol_short = 170U;
        tol_area = 280U;
        tol_aspect = 150U;
    }
    else if (cls == CLASS_COSMETIC)
    {
        tol_long = 135U;
        tol_short = 150U;
        tol_area = 240U;
        tol_aspect = 125U;
    }

    long_s = rel_closeness_score_u32(obj_effective_long_raw(d), g_profiles[cls].ref_long, tol_long);
    short_s = rel_closeness_score_u32(obj_effective_short_raw(d), g_profiles[cls].ref_short, tol_short);
    area_s = rel_closeness_score_u32(d->area_raw, g_profiles[cls].ref_area, tol_area);
    aspect_s = rel_closeness_score_u32(d->aspect_x100, g_profiles[cls].ref_aspect_x100, tol_aspect);

    if (cls == CLASS_PEN)
    {
        prof_s = (long_s * 32U + short_s * 18U + area_s * 18U + aspect_s * 32U) / 100U;
    }
    else if (cls == CLASS_ERASER)
    {
        prof_s = (long_s * 25U + short_s * 25U + area_s * 26U + aspect_s * 24U) / 100U;
    }
    else
    {
        prof_s = (long_s * 28U + short_s * 24U + area_s * 22U + aspect_s * 26U) / 100U;
    }

    /* Wider tolerance does not mean equal probability: this bonus is a smooth
     * confidence bias. Close profile match wins when one object matches two
     * shape rules; loose matches still get only a small bias. */
    if (prof_s >= 850U) return 360U;
    if (prof_s >= 700U) return 300U;
    if (prof_s >= 540U) return 230U;
    if (prof_s >= 380U) return 155U;
    if (prof_s >= 220U) return 85U;
    if (prof_s >= 120U) return 35U;
    return 0U;
}

static int classify_candidate(obj_detection_t *d)
{
    uint8_t i;
    uint8_t best_class = 255U;
    uint32_t best_score = 0U;
    uint32_t best_prof_bonus = 0U;

    if ((d == RT_NULL) || !d->valid) return 0;
    if (obj_is_large_sparse_noise(d)) return 0;

    for (i = 0U; i < UVC_AI_NUM_CLASSES; i++)
    {
        uint32_t shape_s = class_shape_score(i, d);
        uint32_t size_bonus = d->area_raw / 8U;
        uint32_t prof_bonus;
        uint32_t score;

        if (shape_s == 0U) continue;
        if (size_bonus > 160U) size_bonus = 160U;

        /* Non-long objects must still pass solid/shape validation. vadapt can
         * boost a class but cannot turn a pen fragment into cap/eraser. */
        if ((i == CLASS_ERASER || i == CLASS_CAP || i == CLASS_BOX) &&
            (d->fill_x100 < OBJ_MIN_SOLID_FILL_X100))
        {
            continue;
        }
        if ((i == CLASS_COSMETIC) && obj_is_sparse_fused_nonpen(d) &&
            (d->aspect_x100 < 650U))
        {
            continue;
        }

        prof_bonus = profile_soft_bonus(i, d);
        score = shape_s + size_bonus + prof_bonus;

        /* V16: if one physical object satisfies two class rules, choose the
         * class with higher probability score. If the total score is almost
         * tied, use the profile closeness bonus as the tie-breaker instead of
         * relying on class order. */
        if ((score > best_score) ||
            ((best_class != 255U) && (score + 35U >= best_score) && (prof_bonus > best_prof_bonus + 45U)))
        {
            best_score = score;
            best_class = i;
            best_prof_bonus = prof_bonus;
        }
    }

    if ((best_class == 255U) || (best_score < OBJ_MIN_CLASS_SCORE)) return 0;

    d->class_id = best_class;
    d->score_u32 = best_score;
    if (best_score > 1000U) best_score = 1000U;
    d->conf = 0.35f + ((float)best_score / 1000.0f) * 0.60f;
    if (d->conf > 0.96f) d->conf = 0.96f;
    (void)snprintf(d->label, sizeof(d->label), "%s", g_class_names[best_class]);
    return 1;
}

static int detection_from_candidate(const obj_candidate_t *c, obj_detection_t *det, const uint8_t *yuyv, const uint8_t *mask)
{
    uint32_t box_w, box_h, box_area, region_ratio_x100, box_ratio_x100;
    float n, mean_x, mean_y, cov_xx, cov_yy, cov_xy;
    float trace, disc, lambda1, lambda2;
    float long_f, short_f;
    int32_t raw_xmin, raw_ymin, raw_xmax, raw_ymax;

    if ((c == RT_NULL) || (det == RT_NULL) || (c->count == 0U)) return 0;
    if ((c->min_x > c->max_x) || (c->min_y > c->max_y)) return 0;

    memset(det, 0, sizeof(*det));

    box_w = c->max_x - c->min_x + 1U;
    box_h = c->max_y - c->min_y + 1U;
    box_area = box_w * box_h;
    if (box_area == 0U) return 0;

    if (c->count < OBJ_MIN_PIXELS) return 0;

    region_ratio_x100 = (g_sample_pixels == 0U) ? 0U : (c->count * 100U) / g_sample_pixels;
    box_ratio_x100 = (g_sample_pixels == 0U) ? 0U : (box_area * 100U) / g_sample_pixels;
    if ((region_ratio_x100 > OBJ_MAX_REGION_RATIO_X100) ||
        (box_ratio_x100 > OBJ_MAX_BOX_RATIO_X100))
    {
        return 0;
    }

    n = (float)c->count;
    mean_x = (float)c->sum_x / n;
    mean_y = (float)c->sum_y / n;
    cov_xx = ((float)c->sum_xx / n) - mean_x * mean_x;
    cov_yy = ((float)c->sum_yy / n) - mean_y * mean_y;
    cov_xy = ((float)c->sum_xy / n) - mean_x * mean_y;

    trace = cov_xx + cov_yy;
    disc = obj_sqrtf((cov_xx - cov_yy) * (cov_xx - cov_yy) + 4.0f * cov_xy * cov_xy);
    lambda1 = (trace + disc) * 0.5f;
    lambda2 = (trace - disc) * 0.5f;
    if (lambda1 < 0.25f) lambda1 = 0.25f;
    if (lambda2 < 0.25f) lambda2 = 0.25f;

    /* Convert principal-axis variance to approximate object length in raw pixels.
     * For a filled rectangle, variance along an axis is L^2/12. */
    long_f = obj_sqrtf(lambda1 * 12.0f) * (float)BG_DIFF_SAMPLE_STEP;
    short_f = obj_sqrtf(lambda2 * 12.0f) * (float)BG_DIFF_SAMPLE_STEP;

    if (long_f < (float)OBJ_MIN_LONG_RAW) long_f = (float)OBJ_MIN_LONG_RAW;
    if (short_f < (float)OBJ_MIN_SHORT_RAW) short_f = (float)OBJ_MIN_SHORT_RAW;
    if (short_f > long_f)
    {
        float t = short_f;
        short_f = long_f;
        long_f = t;
    }

    det->long_raw = (uint16_t)(long_f + 0.5f);
    det->short_raw = (uint16_t)(short_f + 0.5f);
    det->area_raw = c->count * (uint32_t)BG_DIFF_SAMPLE_STEP * (uint32_t)BG_DIFF_SAMPLE_STEP;
    det->aspect_x100 = (det->short_raw == 0U) ? 9999U : (uint16_t)(((uint32_t)det->long_raw * 100U) / det->short_raw);
    det->fill_x100 = (uint16_t)((c->count * 100U) / box_area);
    det->bbox_long_raw = (uint16_t)(((box_w > box_h) ? box_w : box_h) * BG_DIFF_SAMPLE_STEP);
    det->bbox_short_raw = (uint16_t)(((box_w > box_h) ? box_h : box_w) * BG_DIFF_SAMPLE_STEP);
    det->bbox_aspect_x100 = (det->bbox_short_raw == 0U) ? 9999U :
        (uint16_t)(((uint32_t)det->bbox_long_raw * 100U) / det->bbox_short_raw);

    if ((det->long_raw < OBJ_MIN_LONG_RAW) || (det->short_raw < OBJ_MIN_SHORT_RAW)) return 0;

    raw_xmin = (int32_t)(c->min_x * BG_DIFF_SAMPLE_STEP) - OBJ_BBOX_MARGIN_RAW;
    raw_ymin = (int32_t)(c->min_y * BG_DIFF_SAMPLE_STEP) - OBJ_BBOX_MARGIN_RAW;
    raw_xmax = (int32_t)(((c->max_x + 1U) * BG_DIFF_SAMPLE_STEP) - 1U) + OBJ_BBOX_MARGIN_RAW;
    raw_ymax = (int32_t)(((c->max_y + 1U) * BG_DIFF_SAMPLE_STEP) - 1U) + OBJ_BBOX_MARGIN_RAW;

    if (raw_xmin < 0) raw_xmin = 0;
    if (raw_ymin < 0) raw_ymin = 0;
    if (raw_xmax >= g_src_width) raw_xmax = (int32_t)g_src_width - 1;
    if (raw_ymax >= g_src_height) raw_ymax = (int32_t)g_src_height - 1;

    det->valid = 1U;
    det->count = c->count;
    det->raw_xmin = raw_xmin;
    det->raw_ymin = raw_ymin;
    det->raw_xmax = raw_xmax;
    det->raw_ymax = raw_ymax;

    det->live_contrast = obj_live_contrast_from_current_frame(yuyv, mask, det,
                                                              &det->live_fg_samples,
                                                              &det->live_ring_samples);
    if (det->live_contrast < OBJ_LIVE_GHOST_REJECT_SCORE) return 0;

    if (obj_is_large_sparse_noise(det)) return 0;
    if (obj_is_line_noise(det)) return 0;

    return 1;
}

static void insert_detection_sorted(obj_detection_t *list, uint8_t *count, const obj_detection_t *det)
{
    int i;
    int pos;

    if ((list == RT_NULL) || (count == RT_NULL) || (det == RT_NULL) || !det->valid) return;

    pos = *count;
    if (pos >= UVC_AI_MAX_PREDICTIONS)
    {
        if (det->score_u32 <= list[UVC_AI_MAX_PREDICTIONS - 1U].score_u32) return;
        pos = UVC_AI_MAX_PREDICTIONS - 1U;
    }
    else
    {
        (*count)++;
    }

    for (i = pos - 1; i >= 0; i--)
    {
        if (det->score_u32 <= list[i].score_u32) break;
        if ((uint32_t)i + 1U < UVC_AI_MAX_PREDICTIONS)
        {
            list[i + 1] = list[i];
        }
    }
    list[i + 1] = *det;
}

static void obj_candidate_merge_into(obj_candidate_t *dst, const obj_candidate_t *src)
{
    if ((dst == RT_NULL) || (src == RT_NULL) || (src->count == 0U)) return;
    if (dst->count == 0U)
    {
        *dst = *src;
        return;
    }
    if (src->min_x < dst->min_x) dst->min_x = src->min_x;
    if (src->min_y < dst->min_y) dst->min_y = src->min_y;
    if (src->max_x > dst->max_x) dst->max_x = src->max_x;
    if (src->max_y > dst->max_y) dst->max_y = src->max_y;
    dst->count += src->count;
    dst->sum_x += src->sum_x;
    dst->sum_y += src->sum_y;
    dst->sum_xx += src->sum_xx;
    dst->sum_yy += src->sum_yy;
    dst->sum_xy += src->sum_xy;
}

static uint32_t obj_gap_1d(uint32_t a0, uint32_t a1, uint32_t b0, uint32_t b1)
{
    if (a1 + 1U < b0) return b0 - a1 - 1U;
    if (b1 + 1U < a0) return a0 - b1 - 1U;
    return 0U;
}

static uint8_t obj_candidates_should_merge(const obj_candidate_t *a, const obj_candidate_t *b)
{
    uint32_t gap_x, gap_y, gap_max;
    uint32_t ux0, uy0, ux1, uy1, uw, uh, ul, us, aspect_x100;
    uint32_t box_area, max_gap_allowed;
    uint32_t aw, ah, bw, bh;

    if ((a == RT_NULL) || (b == RT_NULL) || (a->count == 0U) || (b->count == 0U)) return 0U;

    gap_x = obj_gap_1d(a->min_x, a->max_x, b->min_x, b->max_x);
    gap_y = obj_gap_1d(a->min_y, a->max_y, b->min_y, b->max_y);
    gap_max = (gap_x > gap_y) ? gap_x : gap_y;

    /* Never bridge diagonal gaps. This was the main reason for connecting
     * unrelated nearby objects into one fake box/cosmetic object. */
    if ((gap_x > 0U) && (gap_y > 0U)) return 0U;

    aw = a->max_x - a->min_x + 1U;
    ah = a->max_y - a->min_y + 1U;
    bw = b->max_x - b->min_x + 1U;
    bh = b->max_y - b->min_y + 1U;

    /* Reject parallel stacked strips: two pens side-by-side must not be merged
     * just because their bounding boxes are close. Horizontal stacks have y-gap
     * with both parts already wide; vertical stacks have x-gap with both parts tall. */
    if ((gap_y > 1U) && (gap_x == 0U) &&
        (aw > ah * 3U) && (bw > bh * 3U)) return 0U;
    if ((gap_x > 1U) && (gap_y == 0U) &&
        (ah > aw * 3U) && (bh > bw * 3U)) return 0U;

    ux0 = (a->min_x < b->min_x) ? a->min_x : b->min_x;
    uy0 = (a->min_y < b->min_y) ? a->min_y : b->min_y;
    ux1 = (a->max_x > b->max_x) ? a->max_x : b->max_x;
    uy1 = (a->max_y > b->max_y) ? a->max_y : b->max_y;
    uw = ux1 - ux0 + 1U;
    uh = uy1 - uy0 + 1U;
    ul = (uw > uh) ? uw : uh;
    us = (uw > uh) ? uh : uw;
    if (us == 0U) return 0U;

    aspect_x100 = (ul * 100U) / us;
    box_area = uw * uh;
    max_gap_allowed = ul / 7U;
    if (max_gap_allowed < 3U) max_gap_allowed = 3U;
    if (max_gap_allowed > OBJ_MERGE_MAX_GAP_RAW) max_gap_allowed = OBJ_MERGE_MAX_GAP_RAW;

    /* Merge only fragmented parts of a single long object. The union must remain
     * very elongated and not too solid; otherwise it is likely a cluster of
     * different objects placed close together. */
    if ((aspect_x100 >= OBJ_MERGE_MIN_UNION_ASPECT_X100) && (gap_max <= max_gap_allowed))
    {
        uint32_t fill_x100 = ((a->count + b->count) * 100U) / box_area;
        if ((fill_x100 >= 5U) && (fill_x100 <= 55U)) return 1U;
    }

    return 0U;
}

static void merge_fragmented_candidates(obj_candidate_t *regions, uint16_t label_count)
{
    uint8_t pass;
    if (regions == RT_NULL) return;

    for (pass = 0U; pass < OBJ_MAX_FRAGMENT_MERGE_PASSES; pass++)
    {
        uint8_t changed = 0U;
        uint16_t i, j;
        for (i = 1U; i <= label_count; i++)
        {
            if (regions[i].count == 0U) continue;
            for (j = (uint16_t)(i + 1U); j <= label_count; j++)
            {
                if (regions[j].count == 0U) continue;
                if (obj_candidates_should_merge(&regions[i], &regions[j]))
                {
                    obj_candidate_merge_into(&regions[i], &regions[j]);
                    obj_candidate_reset(&regions[j]);
                    changed = 1U;
                }
            }
        }
        if (!changed) break;
    }
}

static uint8_t build_detections_from_mask(const uint8_t *mask, const uint8_t *yuyv, obj_detection_t *out_list, uint8_t do_classify)
{
    obj_candidate_t regions[OBJ_MAX_COMPONENT_LABELS];
    uint16_t label_count;
    uint32_t i;
    uint8_t out_count = 0U;

    if ((mask == RT_NULL) || (out_list == RT_NULL)) return 0U;

    for (i = 0U; i < UVC_AI_MAX_PREDICTIONS; i++)
    {
        memset(&out_list[i], 0, sizeof(out_list[i]));
    }

    label_count = cc_label_mask(mask);
    if (label_count == 0U) return 0U;

    for (i = 0U; i < OBJ_MAX_COMPONENT_LABELS; i++)
    {
        obj_candidate_reset(&regions[i]);
    }

    for (i = 0U; i < g_sample_pixels; i++)
    {
        uint16_t lab = g_label[i];
        uint16_t root;
        uint32_t sx, sy;

        if (lab == 0U) continue;
        root = cc_find(lab);
        if ((root == 0U) || (root >= OBJ_MAX_COMPONENT_LABELS)) continue;
        g_label[i] = root;

        sx = i % g_sample_w;
        sy = i / g_sample_w;
        obj_candidate_add(&regions[root], sx, sy);
    }

    merge_fragmented_candidates(regions, label_count);

    for (i = 1U; i <= label_count; i++)
    {
        obj_detection_t det;
        if (detection_from_candidate(&regions[i], &det, yuyv, mask))
        {
            if (!do_classify || classify_candidate(&det))
            {
                if (!do_classify)
                {
                    det.class_id = 0U;
                    det.score_u32 = det.area_raw;
                    det.conf = 0.50f;
                    (void)snprintf(det.label, sizeof(det.label), "obj");
                }
                insert_detection_sorted(out_list, &out_count, &det);
            }
        }
    }

    return out_count;
}

static void update_last_candidates(const obj_detection_t *dets, uint8_t count)
{
    rt_base_t level;
    uint8_t n = count;
    if (n > UVC_AI_MAX_PREDICTIONS) n = UVC_AI_MAX_PREDICTIONS;

    level = rt_hw_interrupt_disable();
    memset(g_last_candidates, 0, sizeof(g_last_candidates));
    if ((dets != RT_NULL) && (n > 0U))
    {
        memcpy(g_last_candidates, dets, sizeof(obj_detection_t) * n);
    }
    g_last_candidate_count = n;
    rt_hw_interrupt_enable(level);
}

static void fill_result_from_detections(const obj_detection_t *dets, uint8_t det_count, uvc_ai_result_t *result)
{
    uint8_t i;

    if ((dets == RT_NULL) || (result == RT_NULL)) return;

    uvc_ai_reset_result(result);
    result->valid = 1U;
    result->count = det_count;

    for (i = 0U; (i < det_count) && (i < UVC_AI_MAX_PREDICTIONS); i++)
    {
        uint32_t base = (uint32_t)i * 4U;
        result->class_id[i] = dets[i].class_id;
        result->conf[i] = dets[i].conf;
        (void)snprintf(result->class_string[i], UVC_AI_MAX_CLASS_LEN, "%s", dets[i].label);

        result->bbox_int16[base + 0U] = bg_map_x_to_ai(dets[i].raw_xmin);
        result->bbox_int16[base + 1U] = bg_map_y_to_ai(dets[i].raw_ymin);
        result->bbox_int16[base + 2U] = bg_map_x_to_ai(dets[i].raw_xmax);
        result->bbox_int16[base + 3U] = bg_map_y_to_ai(dets[i].raw_ymax);
        result->axis_long[i] = dets[i].long_raw;
        result->axis_short[i] = dets[i].short_raw;
        result->aspect_x100[i] = dets[i].aspect_x100;
        result->area[i] = dets[i].area_raw;
    }
}

int uvc_ai_process_yuyv(const uint8_t *yuyv, uint32_t yuyv_size, uvc_ai_result_t *result)
{
    uint32_t min_frame_size;
    rt_tick_t start_tick, end_tick, now_tick;
    uint32_t sx, sy, idx;
    uint64_t sum_y = 0ULL;
    int64_t signed_delta_sum = 0LL;
    uint32_t rough_changed = 0U;
    uint32_t raw_mask_pixels = 0U;
    uint32_t mean_y;
    int32_t avg_signed_delta;
    uint32_t global_ratio_x100;
    uint8_t diff_threshold;
    obj_detection_t all_candidates[UVC_AI_MAX_PREDICTIONS];
    obj_detection_t detections[UVC_AI_MAX_PREDICTIONS];
    uint8_t candidate_count;
    uint8_t det_count;

    if ((yuyv == RT_NULL) || (result == RT_NULL)) return -RT_EINVAL;
    if ((g_bg_y == RT_NULL) || (g_src_width == 0U) || (g_src_height == 0U)) return -RT_ERROR;

    min_frame_size = (uint32_t)g_src_width * (uint32_t)g_src_height * 2U;
    if (yuyv_size < min_frame_size)
    {
        USB_LOG_WRN("frame too small: %lu < %lu for %ux%u\r\n",
                    (unsigned long)yuyv_size, (unsigned long)min_frame_size,
                    (unsigned)g_src_width, (unsigned)g_src_height);
        return -RT_EINVAL;
    }

    start_tick = rt_tick_get();
    uvc_ai_reset_result(result);
    result->valid = 1U;

    if (!g_bg_valid)
    {
        bg_learn_frame(yuyv);
        end_tick = rt_tick_get();
        result->inference_ms = ((float)(end_tick - start_tick) * 1000.0f) / (float)RT_TICK_PER_SECOND;
        return RT_EOK;
    }

    idx = 0U;
    for (sy = 0U; sy < g_sample_h; sy++)
    {
        for (sx = 0U; sx < g_sample_w; sx++)
        {
            uint8_t cur_y, cur_u, cur_v, dy, chroma;
            uint16_t score;
            bg_get_yuv_sample(yuyv, sx, sy, &cur_y, &cur_u, &cur_v);
            score = bg_yuv_diff_score(cur_y, cur_u, cur_v, g_bg_y[idx], g_bg_u[idx], g_bg_v[idx], &dy, &chroma);

            sum_y += cur_y;
            signed_delta_sum += (int32_t)cur_y - (int32_t)g_bg_y[idx];
            if ((dy > BG_DIFF_THRESHOLD_BASE) || (chroma > BG_CHROMA_WEAK_THRESHOLD) || (score > BG_SCORE_WEAK_BASE)) rough_changed++;
            idx++;
        }
    }

    mean_y = (uint32_t)(sum_y / (uint64_t)g_sample_pixels);
    avg_signed_delta = (int32_t)(signed_delta_sum / (int64_t)g_sample_pixels);
    global_ratio_x100 = (rough_changed * 100U) / g_sample_pixels;
    diff_threshold = bg_dynamic_diff_threshold(rough_changed);

    if ((global_ratio_x100 >= BG_GLOBAL_HARD_CHANGE_X100) ||
        ((global_ratio_x100 >= BG_GLOBAL_CHANGE_X100) &&
         ((avg_signed_delta > BG_GLOBAL_LIGHT_SHIFT_Y) || (avg_signed_delta < -BG_GLOBAL_LIGHT_SHIFT_Y))))
    {
        bg_blend_global_frame(yuyv);
        update_last_candidates(RT_NULL, 0U);
        g_low_contrast_fg_frames = 0U;
        end_tick = rt_tick_get();
        result->inference_ms = ((float)(end_tick - start_tick) * 1000.0f) / (float)RT_TICK_PER_SECOND;

        now_tick = rt_tick_get();
        if ((g_last_log_tick == 0U) || ((now_tick - g_last_log_tick) >= BG_LOG_INTERVAL_TICKS))
        {
            USB_LOG_INFO("scene/global change ignored: ratio=%lu%% avg_delta=%ld mean_y=%lu auto_bg=%u\r\n",
                         (unsigned long)global_ratio_x100,
                         (long)avg_signed_delta,
                         (unsigned long)mean_y,
                         (unsigned)g_auto_background);
            g_last_log_tick = now_tick;
        }
        return RT_EOK;
    }

    idx = 0U;
    memset(g_mask_a, 0, g_sample_pixels);
    memset(g_mask_seed, 0, g_sample_pixels);
    for (sy = 0U; sy < g_sample_h; sy++)
    {
        for (sx = 0U; sx < g_sample_w; sx++)
        {
            uint8_t cur_y, cur_u, cur_v, dy, chroma;
            uint16_t score;
            uint8_t is_weak;
            uint8_t is_strong;
            uint16_t weak_thr = (uint16_t)diff_threshold + 8U;
            uint16_t strong_thr = weak_thr + 22U;

            if (weak_thr < BG_SCORE_WEAK_BASE) weak_thr = BG_SCORE_WEAK_BASE;
            if (strong_thr < BG_SCORE_STRONG_BASE) strong_thr = BG_SCORE_STRONG_BASE;

            bg_get_yuv_sample(yuyv, sx, sy, &cur_y, &cur_u, &cur_v);
            score = bg_yuv_diff_score(cur_y, cur_u, cur_v, g_bg_y[idx], g_bg_u[idx], g_bg_v[idx], &dy, &chroma);

            is_weak = ((score >= weak_thr) || (chroma >= BG_CHROMA_WEAK_THRESHOLD) || (dy >= (uint8_t)(diff_threshold + 4U))) ? 1U : 0U;
            is_strong = ((score >= strong_thr) || (chroma >= BG_CHROMA_STRONG_THRESHOLD) || (dy >= (uint8_t)(diff_threshold + 18U))) ? 1U : 0U;

            g_mask_a[idx] = is_weak;
            g_mask_seed[idx] = is_strong;
            if (is_weak) raw_mask_pixels++;

            if (g_auto_background && !is_weak && (dy <= BG_STABLE_UPDATE_THRESHOLD) && (chroma <= 6U))
            {
                g_bg_y[idx] = (uint8_t)(((uint16_t)g_bg_y[idx] * ((1U << BG_EMA_NORMAL_SHIFT) - 1U) +
                                         (uint16_t)cur_y) >> BG_EMA_NORMAL_SHIFT);
                g_bg_u[idx] = (uint8_t)(((uint16_t)g_bg_u[idx] * ((1U << BG_EMA_NORMAL_SHIFT) - 1U) +
                                         (uint16_t)cur_u) >> BG_EMA_NORMAL_SHIFT);
                g_bg_v[idx] = (uint8_t)(((uint16_t)g_bg_v[idx] * ((1U << BG_EMA_NORMAL_SHIFT) - 1U) +
                                         (uint16_t)cur_v) >> BG_EMA_NORMAL_SHIFT);
            }

            idx++;
        }
    }

    if (((raw_mask_pixels * 100U) / g_sample_pixels) > OBJ_MAX_REGION_RATIO_X100)
    {
        update_last_candidates(RT_NULL, 0U);
        g_low_contrast_fg_frames = 0U;
        end_tick = rt_tick_get();
        result->inference_ms = ((float)(end_tick - start_tick) * 1000.0f) / (float)RT_TICK_PER_SECOND;

        now_tick = rt_tick_get();
        if ((g_last_log_tick == 0U) || ((now_tick - g_last_log_tick) >= BG_LOG_INTERVAL_TICKS))
        {
            USB_LOG_INFO("foreground too large, ignored: fg=%lu/%lu mean_y=%lu diff_thr=%u\r\n",
                         (unsigned long)raw_mask_pixels,
                         (unsigned long)g_sample_pixels,
                         (unsigned long)mean_y,
                         (unsigned)diff_threshold);
            g_last_log_tick = now_tick;
        }
        return RT_EOK;
    }

    if (raw_mask_pixels >= BG_MIN_CHANGED_PIXELS)
    {
        clean_mask_seeded_3x3(g_mask_a, g_mask_seed, g_mask_b);
        bridge_small_orthogonal_gaps(g_mask_b);
        candidate_count = build_detections_from_mask(g_mask_b, yuyv, all_candidates, 0U);
        update_last_candidates(all_candidates, candidate_count);
        det_count = build_detections_from_mask(g_mask_b, yuyv, detections, 1U);
        if (det_count == 0U)
        {
            if (g_low_contrast_fg_frames < 65535U) g_low_contrast_fg_frames++;
            if (g_low_contrast_fg_frames >= BG_GHOST_HEAL_MIN_FG_FRAMES)
            {
                bg_heal_mask_pixels(yuyv, g_mask_b);
            }
        }
        else
        {
            g_low_contrast_fg_frames = 0U;
        }
        fill_result_from_detections(detections, det_count, result);
    }
    else
    {
        det_count = 0U;
        g_low_contrast_fg_frames = 0U;
        update_last_candidates(RT_NULL, 0U);
    }

    end_tick = rt_tick_get();
    result->inference_ms = ((float)(end_tick - start_tick) * 1000.0f) / (float)RT_TICK_PER_SECOND;

    now_tick = rt_tick_get();
    if ((g_last_log_tick == 0U) || ((now_tick - g_last_log_tick) >= BG_LOG_INTERVAL_TICKS))
    {
        if (result->count > 0U)
        {
            uint8_t i;
            for (i = 0U; i < result->count; i++)
            {
                uint32_t base = (uint32_t)i * 4U;
                int16_t cx = (int16_t)((result->bbox_int16[base + 0U] + result->bbox_int16[base + 2U]) / 2);
                int16_t cy = (int16_t)((result->bbox_int16[base + 1U] + result->bbox_int16[base + 3U]) / 2);
                USB_LOG_INFO("target%u %s %.1f%% center=(%d,%d) axis=%u/%u asp=%u area=%lu live=%u bbox_ai=[%d,%d,%d,%d] fg=%lu diff_thr=%u time=%.1fms\r\n",
                             (unsigned)i,
                             result->class_string[i],
                             result->conf[i] * 100.0f,
                             cx, cy,
                             (unsigned)result->axis_long[i],
                             (unsigned)result->axis_short[i],
                             (unsigned)result->aspect_x100[i],
                             (unsigned long)result->area[i],
                             0U,
                             result->bbox_int16[base + 0U], result->bbox_int16[base + 1U],
                             result->bbox_int16[base + 2U], result->bbox_int16[base + 3U],
                             (unsigned long)raw_mask_pixels,
                             (unsigned)diff_threshold,
                             result->inference_ms);
            }
        }
        else
        {
            USB_LOG_INFO("no object src=%ux%u fg=%lu rough=%lu%% mean_y=%lu diff_thr=%u profiles=%u time=%.1fms\r\n",
                         (unsigned)g_src_width, (unsigned)g_src_height,
                         (unsigned long)raw_mask_pixels,
                         (unsigned long)global_ratio_x100,
                         (unsigned long)mean_y,
                         (unsigned)diff_threshold,
                         (unsigned)any_profile_enabled(),
                         result->inference_ms);
        }
        g_last_log_tick = now_tick;
    }

    g_frame_index++;
    return RT_EOK;
}

static int class_id_from_name(const char *name)
{
    uint8_t i;
    if (name == RT_NULL) return -1;
    for (i = 0U; i < UVC_AI_NUM_CLASSES; i++)
    {
        const char *a = name;
        const char *b = g_class_names[i];
        while ((*a != '\0') && (*b != '\0'))
        {
            char ca = *a;
            char cb = *b;
            if ((ca >= 'A') && (ca <= 'Z')) ca = (char)(ca + ('a' - 'A'));
            if (ca != cb) break;
            a++;
            b++;
        }
        if ((*a == '\0') && (*b == '\0')) return (int)i;
    }
    return -1;
}

int uvc_ai_adapt_class(const char *class_name)
{
    int cls;
    obj_detection_t chosen;
    uint8_t count;
    uint8_t i;
    rt_base_t level;

    cls = class_id_from_name(class_name);
    if ((cls < 0) || (cls >= (int)UVC_AI_NUM_CLASSES))
    {
        USB_LOG_INFO("vadapt usage: vadapt pen|eraser|cap|box|cosmetic\r\n");
        return -RT_EINVAL;
    }

    memset(&chosen, 0, sizeof(chosen));

    level = rt_hw_interrupt_disable();
    count = g_last_candidate_count;
    if (count > UVC_AI_MAX_PREDICTIONS) count = UVC_AI_MAX_PREDICTIONS;
    {
        uint32_t best_adapt_score = 0U;
        for (i = 0U; i < count; i++)
        {
            uint32_t shape_s = class_shape_score((uint8_t)cls, &g_last_candidates[i]);
            uint32_t area_bonus = g_last_candidates[i].area_raw / 8U;
            uint32_t adapt_score;

            if (area_bonus > 240U) area_bonus = 240U;
            if (obj_is_large_sparse_noise(&g_last_candidates[i])) continue;

            /* Prefer a candidate whose shape already looks like the class being adapted.
             * For eraser/cap/box, do not learn a random line or paper edge. */
            if ((cls != CLASS_PEN) && (shape_s == 0U)) continue;
            adapt_score = shape_s + area_bonus;
            if (shape_s == 0U) adapt_score = area_bonus / 6U;

            if ((!chosen.valid) || (adapt_score > best_adapt_score))
            {
                chosen = g_last_candidates[i];
                best_adapt_score = adapt_score;
            }
        }
    }
    rt_hw_interrupt_enable(level);

    if (!chosen.valid)
    {
        USB_LOG_INFO("vadapt %s failed: no foreground object. Put only one target in view and wait 1s.\r\n",
                     g_class_names[cls]);
        return -RT_ERROR;
    }

    g_profiles[cls].enabled = 1U;
    g_profiles[cls].ref_long = obj_effective_long_raw(&chosen);
    g_profiles[cls].ref_short = obj_effective_short_raw(&chosen);
    g_profiles[cls].ref_aspect_x100 = chosen.aspect_x100;
    g_profiles[cls].ref_area = chosen.area_raw;
    g_profiles[cls].update_count++;

    USB_LOG_INFO("vadapt %s OK: long=%u short=%u aspect=%u area=%lu fill=%u bbox_raw=[%ld,%ld,%ld,%ld]\r\n",
                 g_class_names[cls],
                 (unsigned)obj_effective_long_raw(&chosen),
                 (unsigned)obj_effective_short_raw(&chosen),
                 (unsigned)chosen.aspect_x100,
                 (unsigned long)chosen.area_raw,
                 (unsigned)chosen.fill_x100,
                 (long)chosen.raw_xmin, (long)chosen.raw_ymin,
                 (long)chosen.raw_xmax, (long)chosen.raw_ymax);
    return RT_EOK;
}

void uvc_ai_print_profiles(void)
{
    uint8_t i;
    USB_LOG_INFO("profiles:\r\n");
    for (i = 0U; i < UVC_AI_NUM_CLASSES; i++)
    {
        if (g_profiles[i].enabled)
        {
            USB_LOG_INFO("  %s: long=%u short=%u aspect=%u area=%lu updates=%lu\r\n",
                         g_class_names[i],
                         (unsigned)g_profiles[i].ref_long,
                         (unsigned)g_profiles[i].ref_short,
                         (unsigned)g_profiles[i].ref_aspect_x100,
                         (unsigned long)g_profiles[i].ref_area,
                         (unsigned long)g_profiles[i].update_count);
        }
        else
        {
            USB_LOG_INFO("  %s: off\r\n", g_class_names[i]);
        }
    }
}

void uvc_ai_clear_profiles(const char *class_name)
{
    int cls;
    if ((class_name == RT_NULL) || (strcmp(class_name, "all") == 0))
    {
        memset(g_profiles, 0, sizeof(g_profiles));
        USB_LOG_INFO("all visual profiles cleared\r\n");
        return;
    }

    cls = class_id_from_name(class_name);
    if ((cls < 0) || (cls >= (int)UVC_AI_NUM_CLASSES))
    {
        USB_LOG_INFO("vclear usage: vclear [pen|eraser|cap|box|cosmetic|all]\r\n");
        return;
    }

    memset(&g_profiles[cls], 0, sizeof(g_profiles[cls]));
    USB_LOG_INFO("profile cleared: %s\r\n", g_class_names[cls]);
}

#ifdef FINSH_USING_MSH
static int uvc_ai_bg_reset(int argc, char **argv)
{
    (void)argc;
    (void)argv;
    bg_reset_state();
    return 0;
}
MSH_CMD_EXPORT(uvc_ai_bg_reset, reset UVC AI background image);

static int uvc_ai_bg_auto(int argc, char **argv)
{
    int value;
    if (argc >= 2)
    {
        value = atoi(argv[1]);
        g_auto_background = (value != 0) ? 1U : 0U;
    }
    USB_LOG_INFO("auto background update = %u, usage: uvc_ai_bg_auto 0|1\r\n",
                 (unsigned)g_auto_background);
    return 0;
}
MSH_CMD_EXPORT(uvc_ai_bg_auto, enable or disable auto background update);

static int vadapt(int argc, char **argv)
{
    if (argc < 2)
    {
        USB_LOG_INFO("usage: vadapt pen|eraser|cap|box|cosmetic\r\n");
        return -RT_EINVAL;
    }
    return uvc_ai_adapt_class(argv[1]);
}
MSH_CMD_EXPORT(vadapt, adapt current visible object size for a class);

static int vprof(int argc, char **argv)
{
    (void)argc;
    (void)argv;
    uvc_ai_print_profiles();
    return 0;
}
MSH_CMD_EXPORT(vprof, print visual size profiles);

static int vclear(int argc, char **argv)
{
    if (argc >= 2) uvc_ai_clear_profiles(argv[1]);
    else uvc_ai_clear_profiles("all");
    return 0;
}
MSH_CMD_EXPORT(vclear, clear visual size profiles);
#endif
