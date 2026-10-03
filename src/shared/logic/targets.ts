import type { Kind } from './model'

/**
 * What a board is built for. A target only changes what the palette offers, the unit of time and
 * one line of guidance for the agent: the board itself is plain words and means the same anywhere.
 */
export const TARGET_IDS = ['minecraft', 'godot', 'unity', 'unreal', 'web', 'generic'] as const
export type TargetId = (typeof TARGET_IDS)[number]

export interface PaletteItem {
  kind: Kind
  title: string
  text: string
}

export interface Target {
  label: string
  /** How time is counted in this engine. */
  time: 'ticks' | 'seconds'
  /** One line for the agent on where such code usually lives. */
  build: string
  palette: PaletteItem[]
}

const common = (time: string): PaletteItem[] => [
  { kind: 'condition', title: 'If', text: '' },
  { kind: 'wait', title: 'Wait', text: `10 ${time}` },
  { kind: 'repeat', title: 'Repeat', text: `every 10 ${time}, 5 times` },
  { kind: 'value', title: 'damage', text: '6' },
  { kind: 'note', title: 'Note', text: '' }
]

export const TARGETS: Record<TargetId, Target> = {
  minecraft: {
    label: 'Minecraft mod',
    time: 'ticks',
    build: 'A Minecraft mod (NeoForge or Fabric, see the project): server-side logic for the gameplay, client-side only for what is drawn. 20 ticks are one second.',
    palette: [
      { kind: 'event', title: 'On cast', text: 'the player presses the skill key' },
      { kind: 'event', title: 'While held', text: 'every tick while the skill key is held' },
      { kind: 'event', title: 'On release', text: 'the player lets go of the skill key' },
      { kind: 'event', title: 'On projectile hit', text: 'the projectile hits a block or an entity' },
      { kind: 'event', title: 'On entity killed', text: 'an entity this skill hurt dies' },
      { kind: 'event', title: 'Every tick while active', text: '' },
      { kind: 'condition', title: 'If sneaking', text: 'the caster is sneaking' },
      { kind: 'condition', title: 'If on ground', text: 'the caster is standing on the ground' },
      { kind: 'condition', title: 'If enough mana', text: 'the caster has at least {cost} mana' },
      { kind: 'action', title: 'Spawn projectile', text: 'spawn a projectile at the hand and shoot it where the caster looks, speed 2' },
      { kind: 'action', title: 'Deal damage', text: 'deal {damage} magic damage to the target' },
      { kind: 'action', title: 'Explode', text: 'explode on the spot: radius 3, {damage} damage, no block damage' },
      { kind: 'action', title: 'Apply effect', text: 'give the target Slowness II for 60 ticks' },
      { kind: 'action', title: 'Knockback', text: 'push the target 1.5 blocks away from the caster' },
      { kind: 'action', title: 'Teleport', text: 'teleport the caster to where they look, up to 12 blocks' },
      { kind: 'action', title: 'Particles', text: 'a ring of particles at the target' },
      { kind: 'action', title: 'Play sound', text: 'play a sound at the caster' },
      { kind: 'action', title: 'Spend mana', text: 'take {cost} mana from the caster' },
      { kind: 'action', title: 'Start cooldown', text: 'the skill cools down for 100 ticks' },
      ...common('ticks')
    ]
  },
  godot: {
    label: 'Godot',
    time: 'seconds',
    build: 'A Godot 4 project: GDScript (or C# if the project uses it), scenes and signals as the project already does.',
    palette: [
      { kind: 'event', title: 'On input', text: 'the player presses the attack action' },
      { kind: 'event', title: 'On ready', text: 'the node enters the scene' },
      { kind: 'event', title: 'On body entered', text: 'a body enters the area' },
      { kind: 'event', title: 'Every frame', text: '' },
      { kind: 'event', title: 'On timer', text: 'the timer runs out' },
      { kind: 'condition', title: 'If on floor', text: 'the character is on the floor' },
      { kind: 'action', title: 'Spawn scene', text: 'instance the bullet scene at the muzzle and fire it forward' },
      { kind: 'action', title: 'Deal damage', text: 'deal {damage} damage to the body' },
      { kind: 'action', title: 'Play animation', text: 'play the "attack" animation' },
      { kind: 'action', title: 'Emit signal', text: 'emit "died"' },
      { kind: 'action', title: 'Change state', text: 'switch to the Chase state' },
      ...common('seconds')
    ]
  },
  unity: {
    label: 'Unity',
    time: 'seconds',
    build: 'A Unity project: C# MonoBehaviours and ScriptableObjects as the project already does.',
    palette: [
      { kind: 'event', title: 'On input', text: 'the player presses Fire' },
      { kind: 'event', title: 'On start', text: '' },
      { kind: 'event', title: 'On trigger enter', text: 'a collider enters the trigger' },
      { kind: 'event', title: 'On collision', text: '' },
      { kind: 'event', title: 'Every frame', text: '' },
      { kind: 'condition', title: 'If grounded', text: 'the character is grounded' },
      { kind: 'action', title: 'Instantiate', text: 'instantiate the projectile prefab at the muzzle and launch it forward' },
      { kind: 'action', title: 'Deal damage', text: 'deal {damage} damage to the hit object' },
      { kind: 'action', title: 'Play animation', text: 'set the "Attack" trigger on the animator' },
      { kind: 'action', title: 'Invoke event', text: 'invoke OnDeath' },
      ...common('seconds')
    ]
  },
  unreal: {
    label: 'Unreal',
    time: 'seconds',
    build: 'An Unreal Engine 5 project: C++ (or Blueprints where the project uses them), Gameplay Ability System if it is set up.',
    palette: [
      { kind: 'event', title: 'On input action', text: 'the player triggers IA_Attack' },
      { kind: 'event', title: 'BeginPlay', text: '' },
      { kind: 'event', title: 'On overlap', text: 'an actor begins overlapping' },
      { kind: 'event', title: 'On hit', text: '' },
      { kind: 'event', title: 'Tick', text: '' },
      { kind: 'condition', title: 'If falling', text: 'the character is falling' },
      { kind: 'action', title: 'Spawn actor', text: 'spawn the projectile actor at the socket and launch it forward' },
      { kind: 'action', title: 'Apply damage', text: 'apply {damage} damage to the hit actor' },
      { kind: 'action', title: 'Play montage', text: 'play the attack montage' },
      { kind: 'action', title: 'Apply effect', text: 'apply a gameplay effect' },
      ...common('seconds')
    ]
  },
  web: {
    label: 'Web app',
    time: 'seconds',
    build: 'A web app (see the project for its framework): components, handlers and API routes as the project already does.',
    palette: [
      { kind: 'event', title: 'On click', text: 'the user clicks Submit' },
      { kind: 'event', title: 'On page load', text: '' },
      { kind: 'event', title: 'On request', text: 'POST /api/orders' },
      { kind: 'event', title: 'On schedule', text: 'every day at 03:00' },
      { kind: 'condition', title: 'If signed in', text: 'the user is signed in' },
      { kind: 'condition', title: 'If valid', text: 'the form passes validation' },
      { kind: 'action', title: 'Call API', text: 'POST the form to /api/orders' },
      { kind: 'action', title: 'Save', text: 'save the order to the database' },
      { kind: 'action', title: 'Show message', text: 'show a toast: "Saved"' },
      { kind: 'action', title: 'Navigate', text: 'go to /orders/{id}' },
      { kind: 'action', title: 'Send email', text: 'email the receipt to the user' },
      ...common('seconds')
    ]
  },
  generic: {
    label: 'Anything',
    time: 'seconds',
    build: 'Follow the project: its language, structure and conventions.',
    palette: [
      { kind: 'event', title: 'When', text: '' },
      { kind: 'action', title: 'Do', text: '' },
      ...common('seconds')
    ]
  }
}
