// Network
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;

// Physics
export const GRAVITY = -28;
export const JUMP_VELOCITY = 9.2;
export const MOVE_SPEED = 5.5;
export const MAX_STEP_DT = 0.05; // clamp per-input integration step

// Player AABB
export const PLAYER_HALF_W = 0.3;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE = 1.62;

// Interaction
export const REACH = 4.5;
export const VOID_Y = -10;

// World dimensions (blocks)
export const WORLD_X = 208;
export const WORLD_Y = 40;
export const WORLD_Z = 208;
export const CHUNK = 16;
