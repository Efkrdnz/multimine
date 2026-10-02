import {
  AppWindow,
  AppWindowMac,
  Bell,
  ChevronsUpDown,
  Crosshair,
  Gauge,
  Grid3x3,
  Heart,
  Image,
  Joystick,
  Layers,
  List,
  Map,
  MessageSquare,
  MessageSquareText,
  PanelTop,
  RectangleHorizontal,
  SlidersHorizontal,
  Sparkle,
  Square,
  SquareCheck,
  SquareDashed,
  Swords,
  TextCursorInput,
  ToggleRight,
  Type,
  type LucideIcon
} from 'lucide-react'
import type { ElementType } from '@shared/sketch/model'

const ICON: Record<ElementType, LucideIcon> = {
  window: AppWindow,
  panel: Square,
  group: Layers,
  button: RectangleHorizontal,
  label: Type,
  textfield: TextCursorInput,
  slot: SquareDashed,
  slotgrid: Grid3x3,
  image: Image,
  icon: Sparkle,
  list: List,
  tabs: PanelTop,
  dropdown: ChevronsUpDown,
  slider: SlidersHorizontal,
  checkbox: SquareCheck,
  toggle: ToggleRight,
  progress: Gauge,
  tooltip: MessageSquare,
  modal: AppWindowMac,
  bar: Heart,
  ability: Swords,
  minimap: Map,
  dialogue: MessageSquareText,
  crosshair: Crosshair,
  joystick: Joystick,
  toast: Bell
}

export function TypeIcon({ type, size = 15 }: { type: ElementType; size?: number }) {
  const I = ICON[type]
  return <I size={size} className="shrink-0" />
}
