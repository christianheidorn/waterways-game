/**
 * Render layers. Everything draws on layer 0 (the camera's). Objects that only cast shadows this frame
 * (e.g. CPU-path foliage batches outside the view whose shadows may still fall into it) leave layer 0
 * and keep SHADOW_LAYER, which only the sun's shadow cameras see.
 */
export const SHADOW_LAYER = 2;
