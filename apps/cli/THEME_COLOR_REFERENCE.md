# CLI Theme Color Reference - Dark Gray Edition

## Color Palette Overview

### Primary Surface Colors (Neutral Dark Gray)
```
Base Background:     #1a1a1a (darkest)
Inset Surfaces:      #1f1f1f
Panel Surfaces:      #252525
Elevated Surfaces:   #2d2d2d (lightest primary)
```

### Border & Divider Colors (Neutral Gray)
```
Default Border:      #333333
Subtle Border:       #3a3a3a
Active Border:       #7DD3FC (cyan accent for interaction)
```

### Text Colors (Light & Readable)
```
Primary Text:        #E6ECF3 (high contrast, main text)
Secondary Text:      #A3AFBE (medium contrast, labels)
Muted Text:          #7E8A99 (low contrast, hints)
```

### Accent Colors (Cyan Highlights)
```
Primary Accent:      #7DD3FC (bright cyan for active states)
Soft Background:     #3a3a3a (gray accent background)
Soft Text:           #D9F3FF (light cyan for emphasis)
```

### Semantic Status Colors (For Functional Feedback)
```
Success (Green):     #7BC08B
Warning (Orange):    #D2A45D
Error (Red):         #D67A7A
Info (Blue):         #8CB4FF
```

### Message Role Colors

#### User Message
```
Label:               #A3C8FF (light blue)
Border:              #3a4a5f (dark gray-blue)
Background:          #242933 (very dark gray-blue)
```

#### Assistant Message
```
Label:               #A9D9BA (light green)
Border:              #3a4a3c (dark gray-green)
Background:          #212927 (very dark gray-green)
```

#### System Message
```
Label:               #B1BBC8 (light gray)
Border:              #3a3a45 (dark gray)
Background:          #242428 (very dark gray)
```

### UI Component Colors

#### Overlay/Dialog
```
Surface:             #252525
Border:              #3a3a3a
Title:               #7DD3FC (cyan)
Selected Row Bg:     #3a3a3a
Selected Row Text:   #D9F3FF (light cyan)
Input Surface:       #2d2d2d
Input Text:          #E6ECF3
```

#### Input Fields
```
Container:           #252525
Field:               #2d2d2d
Focused Border:      #7DD3FC (cyan - active)
Blurred Border:      #3a3a3a
Placeholder:         #7E8A99
Text:                #E6ECF3
Cursor:              #E6ECF3
```

#### Scrollbars
```
Rail:                #1a1a1a (matches base)
Thumb:               #3a3a3a (visible but subtle)
Thumb Active:        #7DD3FC (bright when interacting)
```

### Markdown
```
Table Border:        #3a3a3a
```

---

## Design Characteristics

### Contrast Ratios
- **Primary text on base**: ~14:1 (WCAG AAA compliant)
- **Secondary text on base**: ~8:1 (WCAG AA compliant)
- **Muted text on base**: ~4.5:1 (WCAG A compliant)
- **Cyan accent on gray**: ~6:1 (good visibility)

### Color Temperature
- **Neutral**: No blue or warm undertones
- **Professional**: Clean, modern dark theme aesthetic
- **Accessible**: High contrast for readability
- **Accent-driven**: Cyan provides visual interest and interaction feedback

### Visual Hierarchy
1. **Darkest** (#1a1a1a) - Base background, scroll rail
2. **Dark** (#1f1f1f - #252525) - Panel and container backgrounds
3. **Medium** (#2d2d2d) - Elevated and input surfaces
4. **Borders** (#333333 - #3a3a3a) - Subtle to default dividers
5. **Text** (#7E8A99 - #E6ECF3) - From muted to primary
6. **Accents** (#7DD3FC, #D9F3FF) - Cyan highlights for interaction

---

## Usage Examples

### Component: Chat Message (User)
```
Background:     #242933 (dark gray-blue)
Border:         #3a4a5f (medium gray-blue)
Label Text:     #A3C8FF (light blue)
Message Text:   #E6ECF3 (primary white)
```

### Component: Input Field (Focused)
```
Container:      #252525 (gray panel)
Field:          #2d2d2d (lighter gray)
Border:         #7DD3FC (bright cyan - indicates focus)
Text:           #E6ECF3 (primary white)
```

### Component: Command Palette (Selected Row)
```
Background:     #3a3a3a (medium gray)
Text:           #D9F3FF (light cyan)
Hover Border:   #7DD3FC (cyan accent)
```

### Component: Status Badge (Warning)
```
Background:     #3a3a3a (gray surface)
Text:           #D2A45D (orange warning color)
Border:         #D2A45D (orange accent)
```

---

## Migration Notes

### From Previous Blue Theme
- **All blue surface tints** (#0B0D12, #12161E, #171C25) → Gray equivalents
- **All blue borders** (#2B3340, #30455F) → Neutral gray
- **Accent colors preserved** - Cyan (#7DD3FC) remains unchanged
- **Text colors preserved** - All text values remain the same
- **Semantic colors preserved** - Status colors (green/orange/red/blue) unchanged

### Backwards Compatibility
- **No API changes** - Theme interface remains identical
- **No component changes** - All UI components consume colors the same way
- **Drop-in replacement** - Can be applied without code modifications
- **Easy rollback** - Original theme can be restored from git history

---

## Testing Visual Checklist

- [ ] All backgrounds render as neutral dark gray (no blue/warm tint)
- [ ] Cyan accents (#7DD3FC) stand out on gray backgrounds
- [ ] Text is readable in all contexts
- [ ] Message roles (user/assistant/system) are visually distinct
- [ ] Input focus states show bright cyan border
- [ ] Scrollbar matches base color with visible thumb
- [ ] No color bleeding or unexpected gradients
- [ ] Dialog overlays have appropriate surface separation
- [ ] Status badges (success/warning/error) are clearly visible

---

**Color Scheme Version**: 2.0 - Dark Gray Edition
**Base Background**: #1a1a1a
**Primary Accent**: #7DD3FC (Cyan)
**Status**: Production Ready
