# Design System: OneView

## 1. Visual Theme & Atmosphere
A calm, instrument-grade trading desk at night. The canvas is a deep zinc off-black, and every surface sits on it like a machined glass plate: hairline borders, a single inner highlight along the top edge, and shadows tinted to the canvas, never grey. The mood is quiet confidence, closer to a flight deck dimmed for night flying than to a casino floor. Data is the only thing allowed to be loud.

- **Density:** Daily App Balanced (5): data pages pack tight; the Overview and marketing pages breathe.
- **Variance:** Offset Asymmetric (7): 2:1 splits, bento tiles of mixed width, left-aligned heroes.
- **Motion:** Fluid CSS (6): spring-weighted transitions and staggered reveals, plus one perpetual signal (the live dot). Nothing decorative loops.

## 2. Color Palette & Roles
Every colour comes from `market_update/static/tokens.json` (DTCG: primitives, then semantic tokens), built into `tokens.css` by `python3 scripts/build_tokens.py`. No hex or rgba is written by hand in styles.css or app.js; canvas and SVG code reads a token with `tok("rise-400")` / `tokA("rise-400", .3)`.

- **Night Zinc** (#09090B): the page canvas, everywhere.
- **Plate** (#121216): first-level surfaces such as cards, panels and the menu rail.
- **Raised Plate** (#17171C): second level, for inner tiles, hovered rows and selected menu items.
- **Hairline** (rgba(255,255,255,0.08)): every 1px structural border. Never a solid grey line.
- **Top Light** (rgba(255,255,255,0.06)): the 1px inset highlight on the top edge of raised surfaces.
- **Bright Ink** (#F4F4F5): headings, numbers and primary labels.
- **Soft Ink** (#CFCFD6): body copy.
- **Quiet Ink** (#8A8A96): metadata, descriptions and timestamps.
- **Ember** (#FF7A2F): the single accent, for the active page marker, primary buttons and focus rings. It is used sparingly, as a mark rather than a fill. On the app's dark surfaces it shows as a 2px bar or a dot; full Ember fills are reserved for the one primary action on a screen.
- **Rise** (#3DDC97) / **Fall** (#FF6B85) / **Caution** (#F7C85A): market semantics only, meaning up, down and warning. They are never used for decoration.

On the marketing pages (the landing page and the WhatsApp art), the logo's **Signal Blue** (#3B7BFF) takes Ember's role. The two accents never appear on the same screen.

## 3. Typography Rules
- **Display:** Sora, at weights 600–650, with tracking of -0.03em to -0.045em. Hierarchy comes from weight and colour; the first heading on an app page is never above 30px.
- **Body:** Geist, at 13.5–15px with 1.5–1.6 leading, capped at 65 characters per line, in Soft Ink.
- **Numbers:** Geist Mono with tabular figures, for every price, percentage, count and timestamp, so columns of figures line up.
- **Floor:** nothing on screen is smaller than 11px.
- **Labels:** Geist, 11px, uppercase, tracked +0.12em to +0.16em, in Quiet Ink. Use for eyebrows and group headers only.
- **Banned:** Inter, system serif fonts, and any serif inside the app.

## 4. Component Stylings
- **Menu rail:** a floating Plate pill with a hairline border and a top highlight, detached from the header edges. Items are Quiet Ink text and turn Bright Ink on a Raised Plate background on hover. The active page gets a Raised Plate fill, Bright Ink text, its icon, and a 4px Ember dot under the label. There are no orange blocks, no glows and no sweep animations.
- **Menu panel:** a double-bezel. The outer shell is a 6px translucent tray; inside it sits a Plate core with a header (group name plus one plain sentence) and items as icon tiles (34px, 10px radius, hairline). Each item has a title in Bright Ink and a description in Quiet Ink. The current page is the filled Raised Plate tile with a hairline ring and an Ember icon ring; no bar. Items cascade in over 30ms steps. A footer line shows the keys (↑ ↓ Enter Esc) in mono.
- **Phone menu:** a bottom tab bar (icon over label) with the active tab marked by an Ember dot. Group panels open as a bottom sheet with the same double-bezel and 44px touch rows.
- **Buttons:** pills. The primary button is an Ember fill with Night Zinc text; secondary buttons are ghost with a hairline. On press they scale to 0.98. There are no outer glows.
- **Cards:** 18–22px radius, Plate fill, hairline border and a canvas-tinted shadow. Use them only where grouping needs elevation; inside cards, separate rows with hairlines.
- **Inputs:** label above, helper text optional, error text below in Fall. The focus ring is 3px of Ember at 25% opacity.
- **Loaders:** shimmer skeletons sized to the real layout. No spinners.
- **Empty states:** one sentence on what will appear, plus the action that fills it.

## 5. Layout Principles
- The app shell is a sticky header (logo, menu rail, actions), the page, and a fixed news column on feed pages.
- Grids are CSS Grid with 2:1 and 1:1 splits and bento tiles. The generic row of three equal cards is not used, except for the three Overview answers, which are a deliberate triptych.
- Content is capped at a 1400px max-width, and full-height stages use 100dvh.
- No element overlaps another; every label owns its space.

## 6. Responsive Rules
- **Below 700px:** every grid collapses to one column. The menu becomes the bottom tab bar, and group panels become bottom sheets.
- **No sideways scroll on phones:** wide tables scroll inside their own frame.
- **Touch and type:** touch targets are at least 44px, and headlines scale with clamp().

## 7. Motion & Interaction
- **Easing:** springs approximated with cubic-bezier(0.32, 0.72, 0, 1) for panels and cubic-bezier(0.16, 1, 0.3, 1) for hovers. Never linear, never ease-in-out.
- **Reveals:** staggered cascades of 30–80ms per item. Only transform and opacity animate.
- **One perpetual loop:** the live-market dot pulses while the session is open. Nothing else loops.
- **Reduced motion:** respect prefers-reduced-motion by dropping cascades and the pulse.

## 8. Anti-Patterns (Banned)
- **Visual:**
  - No emojis.
  - No Inter.
  - No pure black (#000000).
  - No neon glows, no purple, no gradient text on app headings.
  - No full Ember fills for navigation.
  - No custom cursors.
- No coloured border on one side only of a card, quote, row or callout: a full hairline carries the tone.
- No native `<select>`: use the `lbx()` listbox in app.js.
- No symbol characters (check marks, crosses, stars) as icons: use the `ICO` line icons.
- **Copy:**
  - No "Elevate", "Seamless", "Unleash" or "Next-Gen".
  - No filler text such as "scroll to explore".
  - No em or en dashes in interface copy; a missing value reads "n/a", a range reads "3 to 6".
- **Honesty:**
  - No invented numbers, reviews, member counts or ratings. Every figure on a page comes from live data.
  - No recommendation language. OneView is information, not advice.
