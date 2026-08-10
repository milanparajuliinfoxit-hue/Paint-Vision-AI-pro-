// Floating toolbar order: Selection tools -> Paint tools -> Utility
// (requirements doc, Section 5.1). Shortcut keys double as the keyboard
// path required by Section 12 (tool selection must be keyboard-operable).
export const TOOL_GROUPS = [
  {
    label: 'Selection',
    tools: [
      { id: 'ai-wall', label: 'AI Wall Detect', glyph: '🪄', shortcut: 'w' },
      { id: 'rect', label: 'Rectangle', glyph: '▭', shortcut: 'r' },
      { id: 'lasso', label: 'Lasso', glyph: '◌', shortcut: 'l' },
      { id: 'polygon', label: 'Polygon', shortcut: 'g', glyph: '⬠' },
      { id: 'magic-wand', label: 'Magic Wand', glyph: '✦', shortcut: 'm' },
      { id: 'surface-pick', label: 'Pick surface', glyph: '◎', shortcut: 's' },
    ],
  },
  {
    label: 'Paint',
    tools: [
      { id: 'brush', label: 'Brush', glyph: '🖌', shortcut: 'b' },
      { id: 'eraser', label: 'Eraser', glyph: '🧽', shortcut: 'e' },
    ],
  },
  {
    label: 'Utility',
    tools: [
      { id: 'eyedropper', label: 'Eyedropper', glyph: '💧', shortcut: 'i' },
      { id: 'pan', label: 'Pan', glyph: '✋', shortcut: 'h' },
    ],
  },
];

export const ALL_TOOLS = TOOL_GROUPS.flatMap((g) => g.tools);

export function toolByShortcut(key) {
  return ALL_TOOLS.find((t) => t.shortcut === key.toLowerCase());
}
