import type { EnvironmentSettings } from '../shared/types';
import { isColorGrade } from './postfx/ColorLut';
import type { Look } from './postfx/common';

export type { LightSource, Look } from './postfx/common';

/** Look values for maps saved before the camera & look fields existed: neutral, effects subtle. */
export const DEFAULT_LOOK: Look = {
    colorGrade: 'neutral',
    colorGradeIntensity: 1,
    whiteBalance: 0,
    exposureCompensation: 0,
    autoExposureMinEv: -2,
    autoExposureMaxEv: 2,
    autoExposureSpeed: 1.5,
    godRayIntensity: 0.5,
    bloomThreshold: 4.5,
    dofFocusDistance: 0,
    dofAperture: 5.6,
    dofMaxBlur: 12,
    motionBlurStrength: 0.5,
    lensFlareIntensity: 0.3,
    chromaticAberration: 0,
    filmGrain: 0,
    letterbox: 0,
    fogDensity: 0.0002,
};

const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

export function lookFromEnvironment(env: Partial<EnvironmentSettings>): Look {
    const d = DEFAULT_LOOK;

    return {
        colorGrade: isColorGrade(env.color_grade) ? env.color_grade : 'neutral',
        colorGradeIntensity: num(
            env.color_grade_intensity,
            d.colorGradeIntensity,
        ),
        whiteBalance: num(env.white_balance, d.whiteBalance),
        exposureCompensation: num(
            env.exposure_compensation,
            d.exposureCompensation,
        ),
        autoExposureMinEv: num(env.auto_exposure_min_ev, d.autoExposureMinEv),
        autoExposureMaxEv: num(env.auto_exposure_max_ev, d.autoExposureMaxEv),
        autoExposureSpeed: num(env.auto_exposure_speed, d.autoExposureSpeed),
        godRayIntensity: num(env.god_ray_intensity, d.godRayIntensity),
        bloomThreshold: num(env.bloom_threshold, d.bloomThreshold),
        dofFocusDistance: num(env.dof_focus_distance, d.dofFocusDistance),
        dofAperture: num(env.dof_aperture, d.dofAperture),
        dofMaxBlur: num(env.dof_max_blur, d.dofMaxBlur),
        motionBlurStrength: num(env.motion_blur_strength, d.motionBlurStrength),
        lensFlareIntensity: num(env.lens_flare_intensity, d.lensFlareIntensity),
        chromaticAberration: num(
            env.chromatic_aberration,
            d.chromaticAberration,
        ),
        filmGrain: num(env.film_grain, d.filmGrain),
        letterbox: num(env.letterbox, d.letterbox),
        fogDensity: num(env.fog_density, d.fogDensity),
    };
}
