# Crewly UI — how to build with it

Crewly is **dark-only**. Every component is designed for the dark surface; on a white page the text is unreadable.

## Wrap everything in `CrewlyRoot`

`CrewlyRoot` applies the page surface: `bg-background-dark`, Nunito, `text-text-primary-dark`. Put the whole screen inside it (give it the size you need):

```jsx
const { CrewlyRoot, Card, Button, Badge, Icons } = window.CrewlyUI;

<CrewlyRoot className="min-h-screen p-6">
  <div className="flex items-center justify-between mb-6">
    <h1 className="text-2xl font-semibold">Teams</h1>
    <Button icon={Icons.Plus}>New team</Button>
  </div>
  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
    <Card>
      <div className="flex items-center justify-between">
        <span className="font-semibold">Growth</span>
        <Badge variant="success">Running</Badge>
      </div>
      <p className="text-sm text-text-secondary-dark mt-1">3 agents · 5 open tasks</p>
    </Card>
  </div>
</CrewlyRoot>
```

## Styling: Tailwind utility classes with Crewly color tokens

Style your own layout with Tailwind classes. Use the Crewly tokens, never raw grays/indigos:

| Role | Classes |
|---|---|
| Page background | `bg-background-dark` |
| Raised surface (cards, panels, inputs) | `bg-surface-dark` |
| Borders, dividers | `border-border-dark`, `divide-border-dark` |
| Main text | `text-text-primary-dark` |
| Secondary / muted text | `text-text-secondary-dark` |
| Brand accent (links, active tab, primary action) | `text-primary`, `bg-primary`, `border-primary`, tints like `bg-primary/10` |
| Status colors | `emerald-*` success, `yellow-*` warning, `rose-*`/`red-*` error |

**Redesign tokens** (`tokens.css`; prefer these in new screens — they follow a future light theme):

| Role | Classes | CSS variable |
|---|---|---|
| Page / card / raised | `bg-bg`, `bg-surface`, `bg-surface-2`, `hover:bg-surface-hover` | `--bg`, `--surface`, `--surface-2`, `--surface-hover` |
| Borders / dividers | `border-border`, `border-border-soft` | `--border`, `--border-soft` |
| Text: main / secondary / tertiary | `text-text`, `text-text-2`, `text-text-3` | `--text`, `--text-2`, `--text-3` |
| Accent | `bg-primary`, `text-primary-text`, `bg-primary-soft`, `text-on-primary` | `--primary`, `--primary-text`, `--primary-soft`, `--on-primary` |
| Status (always with a word) | `text-attention`/`bg-attention-soft` (needs you), `text-success`/`bg-success-soft`, `text-danger`/`bg-danger-soft`, `bg-muted-dot` | `--attention(-soft)`, `--success(-soft)`, `--danger(-soft)`, `--muted-dot` |

Redesign kit: `PageHeader` (title, subtitle, actions, tabs), `UnderlineTabs` (the only tab style in new screens, counts as pills), `CompactRow` (list rows: one primary line, one meta line, ≤2 actions + `overflow` "⋯"), `ShowAll` (first ~5 rows + "Show all N"), `CollapsibleSection` ("More" / "Advanced"), `StatusLabel` (dot + word), `FilterButton` (one Filter popover + chips), `SystemStatusBar` (one line, only when something is wrong).

Radii: `rounded-2xl` for cards, inputs and buttons; `rounded-3xl` for dialogs; `rounded-full` for pills, badges and avatars.

Layout classes available: `flex`, `grid`, `grid-cols-{1,2,3,4,6,12}` (also `sm:`/`md:`/`lg:`), `gap-*`, `p-*`/`px-*`/`py-*`, `m-*`, `space-y-*` (scale 0–16), `w-*`/`h-*` (4–96, `full`, `screen`), `max-w-{sm…7xl}`, `text-{xs…4xl}`, `font-{normal,medium,semibold,bold}`, `items-*`, `justify-*`, `truncate`, `mx-auto`. For anything else (odd sizes, positioning) use an inline `style={{…}}`; the CSS variables `--bg`, `--surface`, `--border`, `--text`, `--text-2`, `--primary`, `--attention` … (and the older `--crewly-*` aliases) hold the same colors.

## Components and props

- Use the library before writing markup: `Button`/`IconButton` for actions (`variant="link"` for inline text actions), `Card` for panels, `Badge`/`StatusBadge`/`StatusDot` for state, `Input`/`Form*`/`Dropdown`/`Toggle` for forms, `SegmentedControl` for view switches (Grid/List, Day/Week), `Tabs`+`TabList`+`TabTrigger`+`TabContent` for tabs, `PageToolbar` for a list page's filter bar, `Table`+`TableHead`/`TableBody`/`TableRow`/`TableHeader`/`TableCell` for records, `EmptyState` for empty lists, `ScoreCard`/`ScoreCardGrid` for metrics, `Modal`/`Popup`/`FormPopup`/`ConfirmPopup` for dialogs, `Drawer` for side panels, `Menu` for action menus, `Tooltip` for hover hints, `Avatar`/`AvatarGroup` for agents and people.
- `Button` is inline (sizes to its label); pass `fullWidth` to fill the row. A `className` you pass wins over the component's own classes for the same property.
- Icons: `window.CrewlyUI.Icons` holds lucide icons (`Plus`, `Trash2`, `Settings`, `Users`, `Bot`, `MessageSquare`, `Search`, `Play`, `Pause`, `RefreshCw`, `Bell`, `Slack`, `Github`, …). Pass the component itself to `icon` props: `icon={Icons.Trash2}`. `TabTrigger`'s `icon` takes an element: `icon={<Icons.Users className="w-4 h-4" />}`.
- Buttons, inputs, selects, textareas and `Card` also accept the native HTML attributes of their element (`onClick`, `disabled`, `type`, `value`, `onChange`, `placeholder`…), although the `.d.ts` lists only the design props.
- Dialogs (`Modal`, `Popup`, `FormPopup`, `ConfirmPopup`, `AlertDialog`, `ConfirmDialog`) render only when `isOpen` is true and cover their positioned container with a dimmed backdrop.

## Where the truth lives

Read `styles.css` (it imports the fonts and `_ds_bundle.css`, the compiled component styles and tokens), each component's `<Name>.d.ts` for its props, and `<Name>.prompt.md` plus its preview for real usage.
