import { AppWindow, Gauge, Grid3x3, Image, Layers, List, MessageSquare, RectangleHorizontal, SlidersHorizontal, Square, SquareCheck, SquareDashed, TextCursorInput, Type, type LucideIcon } from 'lucide-react'
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
  list: List,
  slider: SlidersHorizontal,
  checkbox: SquareCheck,
  progress: Gauge,
  tooltip: MessageSquare
}

export function TypeIcon({ type, size = 15 }: { type: ElementType; size?: number }) {
  const I = ICON[type]
  return <I size={size} className="shrink-0" />
}
