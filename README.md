Patch is a compiled UI framework built for agents. With Patch, agents can inspect an interface and put it into any state directly from the source, without tracing styles through layers of CSS or replaying interactions to reach a particular screen.

- **Local styling.** An element's styles are attached directly to it. There are no selectors, classes, or cascade, so nothing elsewhere in the tree can restyle it, and only a small, well-defined set of properties is supported.
- **Observable state.** App state can be read and overridden from outside the app, which makes it easy to set up fixtures, reproduce bugs, write tests, and export designs.

### Syntax

Markup and reactivity work like Svelte. Use `$style` for reusable styles and inline objects for one-offs.

```svelte
<script lang="ts">
  let count = $state(0)

  const button = $style({
    padding: [8, 12],
    borderRadius: 6
  })
</script>

<button
  style={button}
  onclick={() => count++}
>
  Count: {count}
</button>
```

Inline styles are validated the same way as `$style`:

```svelte
<div
  style={{
    width: "fill",
    padding: 12,
    gap: 8
  }}
>
  ...
</div>
```

### Usage

Link the CLI locally:

```sh
bun link
```

Start the dev server:

```sh
patch dev app.pat
```

Build for production:

```sh
patch build app.pat
```

Take a snapshot of the app and copy it to the clipboard as editable layers, ready to paste into Figma:

```sh
patch snapshot figma app.pat
```

Or write it as a standalone HTML file (`app.snapshot.html`, or a path you pass):

```sh
patch snapshot html app.pat
```

Snapshots render the app from its initial state, without running `$effect`s, so they show exactly that state. You can override any `$state` value, including the state of one component instance (`--state 'Row@22:5[42]/expanded=true'`):

```sh
patch snapshot html app.pat \
  --state loading=true \
  --state filter=done
```

Agents can use HTML snapshots to visually verify the code they write: snapshot the screen in the state they just changed, open the file in a browser, and look at it.

Since state can be set from outside, an agent can jump straight to the screen it wants to look at instead of clicking through the app, mocking network requests, or seeding a database to get there. The same mechanism is what fixtures are built on.

### Scope

Patch currently supports apps made of `.pat` components with:

- TS/JS in `<script>`, with type checking
- Imports from npm packages and local TS/JS modules
- `$state`, `$derived`, and `$effect`
- Components: `import Card from './Card.pat'`, read-only reactive props from `$props()`, callback props instead of two-way binding, `children` and snippets (`{#snippet}`, `{@render}`), and context (`createContext`, `setContext`, `getContext` from `'patch'`)
- `{#if}`, `{:else if}`, `{:else}`, and `{#each}`, keyed (`{#each list as item (item.id)}`) or by position
- `<main>`, `<div>`, `<button>`, `<p>`, `<span>`, `<input>`, and `<textarea>`
- Portals: `<portal id="overlay" />` and `portal="overlay"` render an element elsewhere without changing where it belongs
- `onclick={...}`-style event handlers, `bind:value` on inputs, and `bind:this` for the underlying DOM element
- Flex layout with fixed, `hug`, and `fill` sizing, and scroll containers (`overflow`, `overflowX`, `overflowY`)
- Typography, fills, borders, radii, opacity, shadows, and positioning, including elements anchored to another element from `bind:this`, with collision-aware placement and anchor-relative sizing
- A Vite dev server with live reload, and production builds to a single standalone HTML file
- Snapshots of any state as editable Figma layers or standalone HTML

Still WIP. 
