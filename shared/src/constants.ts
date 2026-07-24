// Network
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;

// Physics (tuned to Minecraft feel, then scaled up ~5x for arcade movement)
export const GRAVITY = -28;
export const JUMP_VELOCITY = 9.2;
export const BASE_MOVE_SPEED = 4.32; // reference MC walk ~4.32 m/s
export const MOVE_SPEED = BASE_MOVE_SPEED * 2.5; // ~2.5x (halved from 5x)
export const SPRINT_MULT = 1.3; // sprint on top of the boosted base
export const MAX_STEP_DT = 0.05; // clamp per-input integration step

// Smooth acceleration / deceleration (exponential approach rate, 1/s).
// Higher = snappier. Ground has strong control, air is floaty.
export const GROUND_ACCEL = 16;
export const AIR_ACCEL = 5;

// Player AABB
export const PLAYER_HALF_W = 0.3;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE = 1.7;

// Interaction
export const REACH = 4.5;
export const ATTACK_REACH = 3.2;
export const VOID_Y = -12;
export const RESPAWN_SECONDS = 3;

// Combat
export const KNOCKBACK_H = 8.5; // horizontal impulse
export const KNOCKBACK_V = 6.5; // vertical impulse
export const CRIT_MULT = 1.5;

// World dimensions (blocks)
export const WORLD_X = 208;
export const WORLD_Y = 48;
export const WORLD_Z = 208;
export const CHUNK = 16;
