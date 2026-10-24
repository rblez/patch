# The Patch language

This is the reference for Patch as currently implemented. A `.pat` file is a component: an optional `<script>` and a template. An app is the `.pat` file you run, plus the components it imports (see [Components](#components)). The template is built from a small set of elements and components, and styled only through `style={...}`.

```svelte
<script lang="ts">
	let count = $state(0);
	let doubled = $derived(count * 2);

	const button = $style({ padding: [8, 12], borderRadius: 6, background: '#18181b', color: '#ffffff' });
</script>

<main style={{ width: 'fill', height: 'fill', padding: 24, gap: 12 }}>
	<p>{count} × 2 = {doubled}</p>
	<button style={button} onclick={() => count++}>Increment</button>
</main>
```

## File structure

- A file has **at most one** `<script>` (or `<script lang="ts">`). Everything outside the script is the template.
- With `lang="ts"` the script is TypeScript and gets type-checked. Without `lang`, or with `lang="js"`, it is JavaScript. Any other `lang` value is treated as JavaScript.
- The template may have any number of top-level nodes. They are stacked in a column inside the viewport (see [The root](#the-root)).
- HTML comments (`<!-- -->`) are ignored.
- Not allowed: `<style>`, `<script module>`, `<svelte:options>`, and any other `<svelte:*>` element.

## Script

The script runs **once** per component instance, top to bottom, before its template is rendered. For the app itself that is once, when the app starts. Every top-level binding (variables, functions, classes, imports) is visible in the template.

### Supported JS/TS

Standard JS and TS work: functions, classes, closures, `async` functions, `try`/`catch`, type aliases, interfaces, generics, `as` / `satisfies` / `!`.

| Not allowed | Diagnostic or behavior |
| --- | --- |
| `export` of any kind | error: a component takes its inputs from [`$props()`](#props) |
| TS `enum` and `namespace` | error |
| dynamic `import()` | error |
| `import x = require(...)` | error |
| `await` outside a function (in the script or a template expression) | error |
| undeclared identifiers starting with `$` (`$state.raw`, `$bindable`, `$inspect`, `$store`, …) | error |
| declaring a name that starts with `$` followed by a letter, `_` or `$` (`$foo`, `$_x`, `$$x`), in the script or the template | error: these names are reserved for runes. A bare `$` is an ordinary name |
| references to identifiers starting with `$$` | error (reserved) |

**No DOM rendering access.** The template and `style={...}` are the only way to affect what renders. Script and template expressions cannot create, query, measure, or restyle DOM nodes, and code that tries is a compile error. Other browser APIs (`fetch`, `localStorage`, `setTimeout`, `document.title`, `window`) are allowed, and so are the rest of a DOM node's own API, such as `el.focus()` on an element from [`bind:this`](#bindthis).

The check applies to values that may come from the DOM: the DOM globals (`document`, `window`, `self`, `globalThis`, …), event objects (in template `on…=` handlers and `addEventListener` callbacks), `bind:this` variables, values typed or cast as DOM types in TS (`HTMLElement`, `Event`, …), and anything read, called, or stored from those. The same property names on ordinary objects are fine. On those values, these are rejected:

- Accessing any of these properties:
  ```
  querySelector  querySelectorAll  getElementById  getElementsByClassName  getElementsByTagName
  getElementsByName  createElement  createElementNS  createTextNode  createDocumentFragment
  appendChild  insertBefore  removeChild  replaceChild  replaceChildren  replaceWith
  insertAdjacentHTML  insertAdjacentElement  insertAdjacentText  innerHTML  outerHTML
  innerText  textContent  setProperty  cssText  classList  className  attachShadow
  getComputedStyle  getBoundingClientRect  adoptedStyleSheets  styleSheets
  ```
- `document.body`, `document.documentElement`, `document.head`, `document.write`, `document.writeln` (also through `window.document`).
- The global `getComputedStyle`.
- Assigning through the `.style` of a DOM value, for example `el.style.color = …`.

### Imports

```ts
import { format } from 'date-fns';          // npm package (ESM or CommonJS)
import { load, type Task } from './api.ts'; // local ES module (.ts, .js, .mjs)
```

- Imports must be static ES imports. They are resolved relative to the `.pat` file.
- Type-only imports are removed from the output.
- A `.pat` file is imported as one component, with a default import: `import Card from './Card.pat'`. A missing file is a compile error. See [Components](#components).
- `'patch'` provides the [context](#context) functions: `import { createContext, setContext, getContext } from 'patch'`, and the type `Context`. It can be imported from `.pat` files and from `.ts`/`.js` modules.
- You cannot import local CommonJS files (`.cjs`, `.cts`). CommonJS npm packages work.
- You cannot import stylesheets (`.css`, `.scss`, `.sass`, `.less`, `.styl`, `.pcss`, …).

### TypeScript checking

With `lang="ts"`, the script is checked against the nearest `tsconfig.json`. If there is none, `strict` is used. DOM types are always available. Unused locals and parameters are not reported. The runes are typed as:

```ts
declare function $state<T>(initial: T): T;
declare function $state<T>(): T | undefined;
declare function $derived<T>(value: T): T;
declare namespace $derived { function by<T>(fn: () => T): T; }
declare function $effect(fn: () => void | (() => void)): void;
declare function $style(style: { readonly [property: string]: unknown }): PatStyle; // opaque
declare function $props(): any; // annotate the destructuring: let { a }: Props = $props()
```

An imported `.pat` component is typed as an opaque component value. Props passed to it in the template are not type-checked (template expressions never are), but a component can type its own props.

Type errors fail `patch build` and `patch snapshot`. `patch dev` shows them in the browser overlay.

**Only the script is type-checked.** Template expressions are checked for names only, in JS and TS alike: a name that is not a script binding, an `{#each}` name, a snippet or snippet parameter, or a global is an error. Their types are not checked. The one exception is `bind:this`: its variable must accept both the element's type and `undefined` (see [`bind:this`](#bindthis)). With `lang="ts"`, template expressions may use TS syntax such as `name as Filter`. Without it, TS syntax in the template is a parse error.

### Where the script runs

| Command | Environment |
| --- | --- |
| `patch dev`, `patch build`, `patch snapshot html` | browser |
| `patch snapshot figma` | Bun, with no DOM or browser globals |

Top-level code that touches browser globals, such as `localStorage.getItem(...)` outside an `$effect`, works in the browser but makes `patch snapshot figma` fail. Put browser-only work in `$effect`, because effects never run in Figma snapshots.

## Reactivity

### `$state`

```ts
let count = $state(0);
let tasks: Task[] = $state([]);
let selected: number | null = $state(null);
let draft = $state(); // undefined
```

- Declare state only as a top-level `let x = $state(...)`. Using `const`, declaring it inside a function or block, or destructuring (`let [a] = $state(...)`) is an error.
- The variable name is the state's id for [design-time overrides](#design-time-state-and-snapshots). In a component, the id is the instance's path and the name (see [State of component instances](#state-of-component-instances)).
- Reading gives the current value. Closures always read the current value.
- Writing works through `=`, compound assignment (`+=`, …), `++`/`--`, and array-destructuring assignment (`[a, b] = [b, a]`). Object-destructuring assignment into a state variable (`({ a } = obj)`) is not supported.
- Assigning a value that is `Object.is`-equal to the current one does nothing. For example, `tasks = tasks` does not update anything.

**Mutation.** An assignment through a member whose chain starts at a state variable notifies every reader of that variable:

```ts
user.name = 'Ada';      // tracked
todos[0].done = true;   // tracked: everything that reads `todos` re-evaluates
counts[key]++;          // tracked
```

`delete user.name` is tracked the same way. Tracking applies to the whole variable, not to individual paths: everything that reads it re-evaluates, including keyed `{#each}` rows rendered from it or from a `$derived` list built from it.

Other in-place changes to a reactive value are **compile errors**, because they would not be tracked. This holds however the value is reached: through the variable, a local alias, destructuring, a `for…of` variable, a callback parameter (`tasks.forEach((t) => …)`), or an element accessor (`find`, `findLast`, `at`, `get`):

```ts
tasks.push(t);                       // error (also pop, shift, unshift, splice, sort, reverse, fill, copyWithin)
map.set(k, v);                       // error (also add, delete, clear)
Object.assign(user, patch);          // error (also Object.defineProperty, Reflect.set, …)
const list = tasks; list.push(t);    // error
const t = tasks.find(byId); t.done = true; // error: write through `tasks` itself
```

A fresh container holding the same elements is not the variable: `const copy = tasks.slice(); copy.push(t); tasks = copy` is fine, but `copy[0].done = true` changes an element of `tasks` and is an error. Copies are recognized from `[...x]`, `{ ...x }`, and `filter`, `slice`, `concat`, `toSorted`, `toReversed`, `toSpliced`, `with`, `flat`, `values`. Values passed into a function through a parameter are not followed, and neither are methods of your own classes.

Prefer assigning new values: `tasks = [...tasks, t]`.

### `$derived`

```ts
let remaining = $derived(tasks.filter((t) => !t.done).length);
const label = $derived.by(() => {
	if (remaining === 0) return 'All done';
	return `${remaining} left`;
});
```

- Declare derived values only at the top level, with `let` or `const`, assigned to a plain identifier. `$derived` takes exactly one expression. `$derived.by` takes exactly one function.
- A derived value is read-only. You cannot assign to it or write through its members.
- It is lazy and cached. It is recomputed on the next read after any `$state` or `$derived` it read changes.

### `$effect`

```ts
$effect(() => {
	localStorage.setItem('tasks', JSON.stringify(tasks));
	document.title = `${remaining} left`;
});

$effect(() => {
	const id = setInterval(tick, 1000);
	return () => clearInterval(id); // cleanup
});
```

- Use `$effect(fn)` only as a top-level expression statement. It takes exactly one function.
- Effects first run **after the initial render**, in declaration order.
- An effect re-runs whenever a `$state` or `$derived` that it read during its last run changes. Dependencies are collected only while `fn` runs synchronously. Reads after an `await` are not tracked.
- If `fn` returns a function, that function runs before the next run and when the app is torn down. Like every closure, it reads state **live**: it sees the current values, not the values from the run being cleaned up. Capture a value in a local to keep the one from that run:
  ```ts
  $effect(() => {
  	const valueAtRun = count;
  	return () => console.log(valueAtRun);
  });
  ```
- Effects may write state. An effect that writes state it also reads triggers itself again. After 1000 such rounds the runtime throws `Reactive loop`.
- An error thrown inside an effect is logged with `console.error`, and the other effects still run.
- In TS, async effect functions are a type error. In JS they are accepted, and the returned promise is ignored.
- **Snapshots render before any effect runs.** Figma snapshots never run them. HTML snapshots start them at the first interaction, just before the first event handler runs; from then on the snapshot behaves like the app.

### Batching

Writes made synchronously inside an event handler are batched. Effects and DOM updates run once, after the handler returns. Writes made after an `await` are not batched: each write updates immediately.

```ts
function twice() { n++; n++; }                         // effects re-run once
async function later() { await x; n++; n++; }          // effects re-run twice
```

## Template

### Elements

| Tag | Kind | Children |
| --- | --- | --- |
| `<main>`, `<div>`, `<button>` | container | elements, text, blocks |
| `<p>`, `<span>` | text | text, `{expressions}`, nested `<span>` |
| `<input>`, `<textarea>` | input | none |
| `<portal>` | [portal](#portals) | none |

A tag starting with an uppercase letter is a [component](#components). Any other tag (`<img>`, `<section>`, `<h1>`, `<a>`, …) is an error.

- **Containers** are flex boxes, laid out in a column by default. `<main>`, `<div>`, and `<button>` lay out identically. `<button>` additionally shows a pointer cursor and accepts `disabled`.
- **Text elements** contain only inline content. A `<span>` nested inside text is an *inline span*: it accepts only `style=`, and that style may contain typography only. You cannot put blocks (`{#if}`, `{#each}`) or other elements inside text. Use a ternary or move the block into a `<div>`.
- **Inputs** cannot have children. Set their content with `value={...}`.

A `<span>` whose parent is a container is a text **block**, not inline:

```svelte
<div>Count: <span>{n}</span></div>  <!-- two stacked blocks: "Count:" and "{n}" -->
<p>Count: <span style={{ fontWeight: 700 }}>{n}</span></p>  <!-- one line -->
```

### Text and whitespace

- Bare text (with `{expressions}`) directly inside a container becomes an unstyled text block. It hugs its content and inherits typography.
- Static whitespace collapses to a single space and is trimmed at the start and end of each text run, including across nested spans. Whitespace between elements is dropped.
- Values of `{expressions}` are inserted verbatim. Spaces and `\n` in them are kept.
- `null`, `undefined`, and `false` render as nothing. Any other value is converted with `String(value)`, so `0` renders as `"0"` and `true` renders as `"true"`.

### Expressions

`{expr}` accepts any JS expression. In expressions you can read top-level script bindings, globals, and `{#each}` item and index names. Expressions re-evaluate when the state they read changes.

### Attributes

Elements accept only these attributes, plus `style=` and event handlers (`on…`):

| Element | Attributes |
| --- | --- |
| `<button>` | `disabled` |
| `<input>` | `value`, `placeholder`, `disabled`, `type` |
| `<textarea>` | `value`, `placeholder`, `disabled` |
| every element except inline spans | [`portal`](#portals) |
| `<portal>` | only a static `id` |

You can write an attribute value in these forms:

```svelte
<button disabled>…</button>                 <!-- true -->
<button disabled={!draft.trim()}>…</button> <!-- expression -->
<input placeholder="Search {count} items" /> <!-- interpolated string: each part is String(v ?? "") -->
```

- `disabled` is applied as `!!value`, so `disabled="false"` disables the element.
- `type` must be a static string: `text`, `password`, `email`, `search`, `url`, or `tel`. The default is `text`.
- `value` sets the field's current value. It is one-way: typing changes the field but not your state. The field is reset only when the expression's value changes.
- Not allowed: `class`, `id` (except on `<portal>`), `title`, `aria-*`, any other attribute, spread attributes (`{...props}`), `class:`, `style:`, `on:event`, `use:`, `transition:`, `animate:`, and `{@attach}`.

### `{#if}`

```svelte
{#if loading}
	<p>Loading…</p>
{:else if error}
	<p style={{ color: '#dc2626' }}>{error}</p>
{:else}
	<p>Ready</p>
{/if}
```

The first branch whose test is truthy is rendered. When the selected branch changes, the old branch's content is destroyed and the new branch's content is created. Re-evaluating to the same branch keeps the existing content.

### `{#each}`

```svelte
{#each tasks as task (task.id)}
	<p>{task.title}</p>
{/each}

{#each tasks as task, i (task.id)}
	<p>{i + 1}. {task.title}</p>
{/each}
```

- The key is `(expr)` after the item name. It can be any expression, and it may use the item and the index.
- **Without a key, items are identified by position**: the item at index 0 is always the first rendered item. When the list changes, each position keeps its rendered content (and the state of the [components](#components) in it) and gets the new item value; positions past the new length are destroyed, and new positions are created. Use a key whenever content or component state must follow the item, for example when the list can be reordered or filtered.
- The item must be a plain identifier. Destructuring (`as { id, title }`) is not supported.
- The list must be an array. `null` and `undefined` render nothing. Anything else, including Sets, Maps, and other iterables, is a runtime error.
- Keys are compared by `SameValueZero`. Object keys compare by identity. A duplicate key is a runtime error.
- With a key, an item whose key is still present keeps its rendered content, including the state of the components in it, and is moved into the new order. Its item value updates when the new element is a different value (`Object.is`), and its index updates too. Items whose keys disappear are destroyed. New keys are created.
- The item and index are read-only. You cannot assign to them or mutate through them, for example with `task.done = true`. Update the source array instead.
- `{:else}` inside `{#each}` is not supported. Use `{#if list.length === 0}`.

### Portals

A portal renders an element somewhere other than where it is written. `<portal id="name" />` marks a destination, and any element with `portal="name"` renders there:

```svelte
<script lang="ts">
	let open = $state(false);
</script>
<main style={{ width: 'fill', height: 'fill' }}>
	<div style={{ overflow: 'hidden' }}>
		<button onclick={() => (open = !open)}>Labels</button>
		{#if open}
			<div portal="overlay" style={{ position: 'absolute', padding: 8, background: '#ffffff' }}>…</div>
		{/if}
	</div>
</main>
<portal id="overlay" />
```

- `<portal>` renders nothing of its own. Elements rendered into it take its place among its parent's children: they are laid out, clipped and painted as children of that parent, and inherit typography from it. Later siblings paint above earlier ones, so a portal written last in the app puts its content above everything else.
- The element still **belongs where it is written**. Its expressions read the same names, its event handlers run as before, it mounts and unmounts with its enclosing `{#if}` or `{#each}`, and `bind:this` sets its variable as usual. Only where it renders changes. Events bubble through the elements it renders in, as in the DOM.
- `portal=` works on every element except an inline span. Its value can be an expression. A nullish or `false` value renders the element in place, so `portal={floating ? 'overlay' : null}` works, and changing the value moves the element.
- Portal ids are app-wide, across components. Several elements can render into one portal. They are kept in the order they were rendered into it (document order on the first render; an element rendered into it later goes last). Do not rely on that order to layer them.
- `<portal>` needs a static, non-empty `id` and takes no other attributes or children. It cannot be repeated by `{#each}` (directly, not inside an `{#if}` in the item), because it would be declared once per item.
- When an element's portal is not rendered, for example because it is in an `{#if}` branch that is not shown, the element is not shown either. It stays mounted and appears as soon as the portal is rendered again. The browser logs an error the first time this happens. A snapshot fails.

These are compile errors: two `<portal>`s in one file with the same id that can be rendered at the same time (they may share an id in different branches of one `{#if}`), a bare `portal` attribute, and a `<portal>` inside the element that renders into it. A component may render into a portal that a component above it declares, so whether a portal exists is checked at runtime, as described above. At runtime, a second portal with an id that is already rendered is logged as an error, and content keeps rendering into the first one.

### Other blocks and tags

These are not supported: `{#await}`, `{#key}`, `{@html}`, `{@const}`, `{@debug}`, and `{@attach}`. `{#snippet}` and `{@render}` are described under [Snippets](#snippets).

## Events and bindings

```svelte
<button onclick={() => count++}>+</button>
<input
	style={{ width: 'fill' }}
	value={draft}
	oninput={(e: Event) => (draft = (e.currentTarget as HTMLInputElement).value)}
	onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && add(draft)}
/>
```

- Use `on<name>={handler}` on any element except an inline span. `<name>` must be lowercase (`onclick`, not `onClick`). It is used directly as a DOM event name, so any DOM event works: `onclick`, `oninput`, `onkeydown`, `onfocus`, `onpointerenter`, and so on.
- The handler expression is evaluated **each time the event fires**. It must produce a function, which receives the DOM `Event`, or `null`/`undefined`, which is ignored. Any other value is a runtime error. This means `onclick={enabled ? save : null}` works.
- State writes in the synchronous part of a handler are [batched](#batching).

`bind:value` keeps an input and a state variable in sync:

```svelte
<script lang="ts">
	let query = $state('');
</script>
<input style={{ width: 240 }} bind:value={query} placeholder="Search" />
```

- `bind:value` is allowed only on `<input>` and `<textarea>`. Its target must be a **top-level `$state` identifier**. A derived value, a member (`form.name`), or an each item is not allowed.
- It is equivalent to `value={query}` plus an `input` handler that sets `query = event.currentTarget.value`. The bound value is always a string.
- You cannot combine it with `value=` or `oninput=` on the same element.

### `bind:this`

`bind:this` puts an element's underlying DOM node in a variable. The value is the real element, such as an `HTMLInputElement`, not a wrapper, so you use the DOM's own API on it:

```svelte
<script lang="ts">
	let open = $state(false);
	let input = $state<HTMLInputElement>();

	// Runs when the input mounts (and again when it unmounts).
	$effect(() => input?.focus());
</script>
<button onclick={() => (open = true)}>Search</button>
{#if open}
	<input style={{ width: 240 }} bind:this={input} />
{/if}
```

- `bind:this` works on any element except an inline span. Its target must be a **top-level `$state` variable**, such as `let input = $state<HTMLInputElement>()`. Patch writes the element into it as the element mounts and unmounts, so it changes like any state, and expressions, styles and effects that read it update. A plain `let`, a `const`, a derived value, a member (`refs.input`), or an each item is not allowed. You can combine it with `bind:value`.
- The variable holds the element while the element is mounted. Before the element mounts and after it unmounts, it holds `undefined`. When an `{#if}` branch is destroyed, its elements unmount; when an `{#each}` item is removed, its elements unmount.
- It is set as the element mounts, during the render that follows a state change, which is **after** the event handler that made the change returns (see [Batching](#batching)). So in `open = true; input?.focus()`, the input does not exist yet. To act on a newly mounted element, read the variable in an `$effect`, as above.
- If several mounted elements bind the same variable, for example one in each `{#each}` item, it holds the most recently mounted one. When that element unmounts, the variable becomes `undefined`, even if others are still mounted.
- In TS, the variable must accept the element's type and `undefined`, as `$state<HTMLInputElement>()` does. A type that rejects `undefined`, such as `let input: HTMLInputElement | null = $state(null)`, is a type error. Each tag is typed as follows:

  | Tag | Type |
  | --- | --- |
  | `<main>` | `HTMLElement` |
  | `<div>` | `HTMLDivElement` |
  | `<button>` | `HTMLButtonElement` |
  | `<p>` | `HTMLParagraphElement` |
  | `<span>` | `HTMLSpanElement` |
  | `<input>` | `HTMLInputElement` |
  | `<textarea>` | `HTMLTextAreaElement` |
- The [DOM rendering rules](#supported-jsts) still apply to the element: `input.focus()`, `input.select()`, and `input.value` are fine, but `input.querySelector(…)`, `input.getBoundingClientRect()`, and `input.style.color = …` are compile errors.
- Figma snapshots have no DOM. There the variable holds an opaque stand-in for the element, so it can be an [`anchor`](#anchored-positioning); it has none of an element's API.

No other bindings exist (`bind:checked`, `bind:group`, …).

## Components

Every `.pat` file is a component. Import it and render it with a tag that starts with an uppercase letter:

```svelte
<script lang="ts">
	import Button from './Button.pat';
</script>
<Button label="Save" onpress={save} />
```

- The tag must be a plain name in scope: usually the import, but any variable holding a component works. `<ui.Button>` is not supported; assign it to a name first. A name that is not defined is a compile error, and a value that is not a component is a runtime error.
- A component may render any number of top-level nodes; there is no wrapper element. Its nodes take its place in the parent's layout, as if they were written there, and inherit typography from there.
- Components cannot appear inside text (`<p>`), like other elements.

### Props

A component receives its inputs from `$props()`, destructured at the top level of its script:

```svelte
<!-- Input.pat -->
<script lang="ts">
	let { name, placeholder = 'Name', updateName }: {
		name: string;
		placeholder?: string;
		updateName: (next: string) => void;
	} = $props();
</script>
<input style={{ width: 200 }} value={name} {placeholder} oninput={(e: Event) => updateName((e.currentTarget as HTMLInputElement).value)} />
```

- Every attribute on a component tag is a prop: `label="Save"` (a string), `count={n}` (an expression), `title="Hi {name}"` (an interpolated string), `disabled` (`true`), `{name}` (`name={name}`). Event-like names such as `onpress` are ordinary props too.
- `$props()` may appear once, as `let { … } = $props()` (or `const`). Each property is a prop name, optionally renamed (`{ label: text }`) or with a default (`{ count = 0 }`). Rest (`...rest`), nested destructuring, and keeping the whole object (`let props = $props()`) are not supported. Props a component does not destructure are ignored.
- A default applies when the parent does not pass the prop or passes `undefined`. It is computed when needed and kept until what it reads changes.
- **Props are read-only and reactive.** Reading one reads the parent's expression. When something that expression reads changes, everything in the child that reads the prop updates, as with any `$state`. The component is not created again and nothing else is re-rendered, so its local state is kept.
- Assigning to a prop, or changing it in place (`item.done = true`, `list.push(x)`), is a compile error. A prop's value belongs to the parent.

There is no two-way binding: no `bind:` on components and no `$bindable`. Data flows down through props, and a child asks for a change by calling a callback prop. The parent owns the state, updates it, and the new value flows back down:

```svelte
<script lang="ts">
	import Input from './Input.pat';
	let name = $state('');
</script>
<Input name={name} updateName={(next) => (name = next)} />
```

### Local state and lifetime

A component instance owns the `$state`, `$derived` and `$effect`s its script declares. The script runs once, when the instance is created. Its effects run after it is rendered, and their cleanups run when it is destroyed.

An instance lives as long as the place that renders it:

- In an `{#if}` branch, it is destroyed when the branch is left and created again, with fresh state, when the branch is entered again.
- In a keyed `{#each}`, it belongs to its key: when the list is reordered its state moves with the item, and when the key disappears it is destroyed.
- In an unkeyed `{#each}`, it belongs to its position: after a reorder, the instance at a position keeps its state and receives the item now at that position.
- When the tag's value is a different component, the old instance is destroyed and the new one is created. A changed prop never replaces the instance.

```svelte
{#each rows as row (row.id)}
	<Row row={row} />  <!-- a Row's `expanded` follows its row.id -->
{/each}
```

### Snippets

A snippet is a reusable piece of template, declared with `{#snippet}` and rendered with `{@render}`:

```svelte
{#snippet badge(label, color)}
	<div style={{ padding: [2, 6], borderRadius: 4, background: color }}>
		<p>{label}</p>
	</div>
{/snippet}

{@render badge('New', '#dcfce7')}
{@render badge(count + ' open', '#e0e7ff')}
```

- A snippet captures the scope it is declared in: script bindings, `{#each}` items and other snippets. It is visible in the block that declares it (its sibling nodes and everything inside them), not in the script. Two snippets with the same name in one block are an error.
- Parameters are plain names (no defaults or destructuring), read-only, and reactive: when an argument expression's value changes, the rendered snippet updates in place.
- A snippet is not a component instance. It owns no state (the template cannot declare state), and what it renders belongs to the place it is rendered: it is destroyed with that place, and components in it are children of the component rendering it (see [Context](#context)).
- `{@render}` takes one call: `{@render name(args)}`. Rendering a value that is not a snippet is a runtime error. `{@render name?.(args)}` renders nothing when the value is `null` or `undefined`. When the value becomes a different snippet, the old content is destroyed and the new one is rendered.
- Snippets are values, so they can be passed as props: `<List row={rowSnippet} />`, rendered in `List.pat` with `{@render row(item)}`.

### Children

Content written inside a component tag is passed as the `children` prop, a snippet without parameters:

```svelte
<!-- Card.pat -->
<script lang="ts">
	let { title, children } = $props();
</script>
<div style={{ padding: 16, gap: 8, borderWidth: 1, borderColor: '#e4e4e7' }}>
	<p style={{ fontWeight: 600 }}>{title}</p>
	{@render children?.()}
</div>
```

```svelte
<Card title="Profile">
	<p>Signed in as {user.name}</p>  <!-- reads the caller's `user` -->
</Card>
```

- The content keeps the caller's scope, like any snippet.
- There are no slots. For more than one region, pass snippets as ordinary props (`<Card header={header} />`). A `{#snippet}` written directly inside a component tag is an error, because it would not be passed; declare it outside and pass it.
- Passing both a `children` attribute and content is an error.

### Context

Context passes a value to every component below an instance without threading it through props:

```ts
// theme.ts
import { createContext } from 'patch';
export type Theme = { accent: string; readonly mode: 'light' | 'dark' };
export const ThemeContext = createContext<Theme>();
```

```svelte
<!-- App.pat -->
<script lang="ts">
	import { setContext } from 'patch';
	import { ThemeContext } from './theme.ts';
	let mode: 'light' | 'dark' = $state('light');
	setContext(ThemeContext, { accent: '#2563eb', get mode() { return mode; } });
</script>
```

```svelte
<!-- Button.pat, anywhere below App -->
<script lang="ts">
	import { getContext } from 'patch';
	import { ThemeContext } from './theme.ts';
	const theme = getContext(ThemeContext);
</script>
<button style={{ color: theme.accent }}>{theme.mode}</button>
```

- `createContext<T>()` returns a new opaque key. Keys are compared by identity, so export the key from a `.ts` module that both sides import.
- `setContext(key, value)` provides `value` to the current instance and every component it renders, directly or through snippets and children. It may only be called as a top-level statement of a component's script. Calling it again with the same key replaces the value.
- `getContext(key)` returns the value from the nearest instance that set `key`, starting with the current one. Nested providers shadow outer ones. It may be called anywhere in a component's script or template.
- **A missing context is an error**: `getContext` throws when no instance above set the key, and that instance fails to render. There is no default value; provide one at the top of the app if every consumer needs one.
- Context follows component ancestry, not element nesting: content passed as `children` and rendered by `Card` sees the contexts `Card` and its ancestors set.
- Context is not reactive by itself. The value is passed as it is, once. To share state that changes, pass something that reads it, such as a getter (`get mode() { return mode; }`) or functions. Reading it then updates like any other read of that state.
- `setContext` and `getContext` only work in a `.pat` script; called from a `.ts` module they throw.

## Styles

Styles are attached to elements only through `style={...}`. There are no classes, selectors, stylesheets, or cascade. The only exception is that [typography inherits](#typography-and-inheritance).

### Inline styles

```svelte
<div style={{ width: 'fill', padding: 12, gap: 8, background: '#fafafa' }}>…</div>
```

An object literal written in `style=` is compiled exactly like `$style({...})`.

### `$style(...)`

```ts
const card = $style({ width: 480, padding: 24, gap: 16, background: '#ffffff', borderRadius: 16 });
```

`$style` takes exactly one object. It validates the object, expands shorthands, and returns a frozen style value. Treat that value as opaque: compose it, don't read it. In TS its type is `PatStyle`, whose properties are all `unknown`. You can call `$style` anywhere, including in functions and template expressions:

```ts
const tone = (c: string) => $style({ color: c });
```

### Composition and merging

A style value can be:

- an object or `$style` value
- an array of style values, which may be nested
- a falsy value (`false`, `null`, `undefined`, `0`), which is skipped

```svelte
<button style={[button, ghost, filter === name && selected, { padding: [4, 8] }]}>…</button>
```

The merge rules are:

1. Entries merge **left to right**, and later entries win.
2. Each object is normalized before merging. `padding` and `margin` expand to their four longhands, so precedence applies **per side**, and `overflow` expands to `overflowX` and `overflowY`, so it applies **per axis**:
   ```ts
   [{ padding: 8 }, { paddingLeft: 0 }]  // 8 8 8 0
   [{ paddingLeft: 0 }, { padding: 8 }]  // 8 8 8 8
   [{ overflow: 'hidden' }, { overflowY: 'auto' }]  // x hidden, y auto
   ```
3. `borderRadius` and `boxShadow` are replaced as a whole.
4. A property whose value is `null` or `undefined` is ignored. It does **not** unset an earlier value. To override something, set an explicit neutral value: `width: 'hug'`, `gap: 0`, `borderWidth: 0`, `boxShadow: []`, `opacity: 1`, or `background: '#0000'`.
5. `left`, `top` and the [anchor properties](#anchored-positioning) belong to absolute positioning. An entry with `position: 'flow'` leaves that mode and discards those set by earlier entries, so switching back to `'absolute'` later does not bring them back:
   ```ts
   [{ position: 'absolute', left: 4 }, { position: 'flow' }]                          // { position: 'flow' }
   [{ position: 'absolute', left: 4 }, { position: 'flow' }, { position: 'absolute' }] // { position: 'absolute' }
   [{ position: 'absolute', left: 4 }, { position: 'absolute', top: 2 }]              // keeps left: 4
   ```
   One object that sets `position: 'flow'` together with `left`, `top` or `anchor` is an error. Unlike other properties, a nullish `anchor` is kept, and overrides an earlier one (see [Anchored positioning](#anchored-positioning)).
6. [Combination rules](#combination-rules) are checked on the **merged** result, so `[row, { justifyContent: 'space-between', gap: 0 }]` is valid even if `row` sets a gap.

Strings are never styles. A string or template literal in a style position is a compile error, and that includes `''`. For example, `cond ? card : ''` fails. Use `false` or `null` instead.

### When styles are validated

Every style is checked against the same rules: property names, values, the properties [allowed on the element](#allowed-properties-by-element), and the [combination rules](#combination-rules). What the compiler can resolve is checked at compile time. Everything else is checked at runtime.

**At runtime**, a style error is logged to the console. On first render the element is shown without its style, and the rest of the page still renders. On update the element keeps its previous style. Either way, the style applies once its value becomes valid. In snapshots, a style error fails the snapshot.

**At compile time**, the compiler checks property names and literal values, following a `style=` expression through:

- object literals, arrays, `&&`, `||`, `??`, and ternaries
- `$style({...})` calls (also checked on their own, where any property is allowed)
- names given one value and never reassigned (`const` or `let`): aliases, arrays of styles, conditionals
- members of object constants (`variants.primary`, and every value for `variants[name]`)
- calls of functions declared once, through their `return` values

Combination rules are checked on each element's merged style wherever the outcome is certain: in every way the style can evaluate, or in every way that takes one particular branch. Object and array literals reached through a name may be changed later, so only their keys and literal values are checked, not their combinations. `$style` values are frozen.

Anything the compiler cannot follow is left to runtime: non-literal values, computed keys, spread entries, reassigned names, and other expressions.

## Style properties

Units are pixels. All numbers must be finite.

| Notation | Meaning |
| --- | --- |
| *px* | number ≥ 0 |
| *num* | any number (negatives allowed) |
| *color* | `#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa` (any case). No named colors, `rgb()`, `transparent`, gradients, or images |
| *size* | *px*, `'hug'`, or `'fill'` |

### Layout (containers only)

| Property | Values | Default |
| --- | --- | --- |
| `display` | `'flex'` (has no effect: every container is flex) | `'flex'` |
| `flexDirection` | `'row'`, `'column'` | `'column'` |
| `justifyContent` | `'start'`, `'center'`, `'end'`, `'space-between'` | `'start'` |
| `alignItems` | `'start'`, `'center'`, `'end'`, `'baseline'` (no `'stretch'`: use `'fill'`) | `'start'` |
| `flexWrap` | `'wrap'`, `'nowrap'` | `'nowrap'` |
| `gap` | *px* | `0` |
| `overflow` | `'visible'`, `'hidden'`, `'auto'`, `'scroll'`: shorthand for both axes | `'visible'` |
| `overflowX`, `overflowY` | `'visible'`, `'hidden'`, `'auto'`, `'scroll'` | `'visible'` |

### Box (containers, text, inputs)

| Property | Values | Default |
| --- | --- | --- |
| `width`, `height` | *size*, or `'anchor'` (the anchor's width or height; [anchored](#anchored-positioning) elements only) | `'hug'` |
| `minWidth`, `minHeight` | *px* | none |
| `maxWidth`, `maxHeight` | *px*, or `'available'` (the room at the anchored placement; [anchored](#anchored-positioning) elements only) | none |
| `margin` | *num* or `'auto'`; or `[vertical, horizontal]`; or `[top, right, bottom, left]` | `0` |
| `marginTop`, `marginRight`, `marginBottom`, `marginLeft` | *num* or `'auto'` | `0` |
| `alignSelf` | `'start'`, `'center'`, `'end'`, `'baseline'` | parent's `alignItems` |
| `position` | `'flow'`, `'absolute'` | `'flow'` |
| `left`, `top` | *num* | none |
| `anchor` | an element from `bind:this` (or `null`/`undefined`: none yet) | none |
| `anchorPosition` | a *placement*: `'top'`, `'top-start'`, `'top-end'`, `'right'`, `'right-start'`, `'right-end'`, `'bottom'`, `'bottom-start'`, `'bottom-end'`, `'left'`, `'left-start'`, `'left-end'` | `'bottom'` |
| `anchorOffset` | *num* | `0` |
| `anchorCrossOffset` | *num* | `0` |
| `anchorPadding` | *px*; or `[vertical, horizontal]`; or `[top, right, bottom, left]` | `0` |
| `anchorFallbacks` | an array of *placements* | the opposite side |
| `opacity` | number from 0 to 1 | `1` |

### Paint (containers, inputs)

| Property | Values | Default |
| --- | --- | --- |
| `padding` | *px*; or `[vertical, horizontal]`; or `[top, right, bottom, left]` | `0` |
| `paddingTop`, `paddingRight`, `paddingBottom`, `paddingLeft` | *px* | `0` |
| `background` | *color* | none |
| `borderWidth` | *px* | `0` |
| `borderColor` | *color* | `'#000000'` |
| `borderRadius` | *px*, or `[topLeft, topRight, bottomRight, bottomLeft]` | `0` |
| `boxShadow` | `{ x?, y?, blur?, spread?, color?, inset? }` or an array of them | none |

A shadow's `x`, `y`, and `spread` are *num*, `blur` is *px*, `color` is *color*, and `inset` is a boolean. Missing fields default to `0, 0, 0, 0, '#00000040', false`. Other keys are rejected. A shadow is drawn outside the box, or inside it with `inset: true` (an inner shadow in Figma), and an array draws several.

### Typography (all elements, inherited)

| Property | Values | Default |
| --- | --- | --- |
| `color` | *color* | `'#000000'` |
| `fontFamily` | non-empty string, a single family name | `'Inter'` |
| `fontSize` | *px* > 0 | `16` |
| `fontWeight` | integer from 1 to 1000 | `400` |
| `fontStyle` | `'normal'`, `'italic'` | `'normal'` |
| `lineHeight` | *px* > 0 (pixels, **not** a multiplier: `1.5` means 1.5px) | 1.2 × `fontSize` |
| `letterSpacing` | *num* | `0` |
| `textAlign` | `'start'`, `'center'`, `'end'` (not allowed on inline spans) | `'start'` |
| `textDecoration` | `'none'`, `'underline'`, `'line-through'` | `'none'` |
| `textTransform` | `'none'`, `'uppercase'`, `'lowercase'`, `'capitalize'` | `'none'` |

`textDecoration` is inherited like the rest of typography, so unlike in CSS, a nested span can remove a decoration with `textDecoration: 'none'`. The line takes the color of the text it decorates. `textTransform` changes how text is shown, not the text itself: `bind:value` and the characters of a Figma layer keep their original case. `'capitalize'` uppercases the first letter of each word.

### Truncation (text elements only, not inherited)

| Property | Values | Default |
| --- | --- | --- |
| `textOverflow` | `'clip'`, `'ellipsis'` | `'clip'` |
| `maxLines` | integer ≥ 1 (requires `textOverflow: 'ellipsis'`) | `1` |

With `textOverflow: 'ellipsis'`, a `<p>` or block `<span>` shows at most `maxLines` lines. Its text wraps at its width, even a width it hugs (which then only wraps where `maxWidth` limits it), and when text is cut, the last line shown ends with `…`. The height hugs the lines shown. `'clip'` is the usual behavior: nothing is cut, and the text overflows instead.

```svelte
<p style={{ width: 'fill', textOverflow: 'ellipsis' }}>{issue.title}</p>
<p style={{ width: 'fill', textOverflow: 'ellipsis', maxLines: 2 }}>{issue.description}</p>
```

In a Figma snapshot, the text layer is truncated the same way, with Figma's own truncation and line limit. One whose width hugs keeps the width it was measured at.

### Interaction

| Property | Values | Default | Allowed on |
| --- | --- | --- | --- |
| `cursor` | `'auto'`, `'default'`, `'pointer'`, `'text'`, `'move'`, `'grab'`, `'grabbing'`, `'not-allowed'`, `'wait'`, `'progress'`, `'help'`, `'crosshair'`, `'ew-resize'`, `'ns-resize'`, `'nesw-resize'`, `'nwse-resize'`, `'col-resize'`, `'row-resize'`, `'zoom-in'`, `'zoom-out'`, `'none'` | `'pointer'` on `<button>`, `'text'` on inputs, else `'auto'` | all elements |
| `userSelect` | `'auto'`, `'none'`, `'text'`, `'all'` | `'auto'` | all elements |
| `pointerEvents` | `'auto'`, `'none'` | `'auto'` | all elements |
| `touchAction` | `'auto'`, `'none'`, `'pan-x'`, `'pan-y'`, `'manipulation'` | `'auto'` | all but inline spans |
| `overscrollBehavior` | `'auto'`, `'contain'`, `'none'` | `'auto'` | containers |
| `caretColor` | *color* | the text color | containers, `<input>`, `<textarea>` |

They behave as in CSS, inheritance included: `cursor`, `pointerEvents`, and `caretColor` inherit, and the others apply to the element itself (`userSelect: 'none'` still covers its contents). `pointerEvents: 'none'` lets clicks and hovers pass through to whatever is underneath, and its handlers do not fire. `overscrollBehavior: 'contain'` keeps a scroll container from scrolling the page once it reaches its end. These properties do not change how anything looks, so Figma snapshots ignore them.

Any property not listed here is an error. That includes `zIndex`, `right`, `bottom`, `flex`, `flexGrow`, `border`, `fontWeight: 'bold'`, string units like `'4px'`, and percentages like `'100%'`.

### Allowed properties by element

| Element | Layout | Box | Paint | Typography | Truncation | Interaction |
| --- | --- | --- | --- | --- | --- | --- |
| `<main>`, `<div>`, `<button>` | ✓ | ✓ | ✓ | ✓ | | ✓ |
| `<input>`, `<textarea>` | | ✓ | ✓ | ✓ | | ✓ except `overscrollBehavior` |
| `<p>`, `<span>` (block) | | ✓ | | ✓ | ✓ | `cursor`, `userSelect`, `pointerEvents`, `touchAction` |
| inline `<span>` inside text | | | | ✓ except `textAlign` | | `cursor`, `userSelect`, `pointerEvents` |

For example, a `<p>` cannot have `padding`, `background`, a border, a radius, or a shadow. Wrap it in a `<div>` for those.

### Combination rules

These are checked on the merged style, by the compiler where the outcome is certain and always at runtime:

- `justifyContent: 'space-between'` cannot be combined with a non-zero `gap`, or with `flexWrap: 'wrap'`.
- `left` and `top` require `position: 'absolute'`.
- `overflowX: 'visible'` cannot be combined with any other `overflowY`, and the other way around.
- `anchor` requires `position: 'absolute'`, and cannot be combined with `left`, `top` or a non-zero margin. The other anchor properties, `width`/`height: 'anchor'` and `maxWidth`/`maxHeight: 'available'` require `anchor`.
- An absolute element cannot use `'fill'` for `width` or `height`.
- `maxLines` requires `textOverflow: 'ellipsis'`.
- `<input>` needs `width` set to a number or `'fill'`. `<textarea>` needs both `width` and `height` set to a number or `'fill'`. A bare `<input />` is a compile error.

## Layout

Every container is a flex box. Children follow source order along the main axis (`flexDirection`) and are separated by `gap`. On the cross axis they are placed by `alignItems`, which a child can override with `alignSelf`. Children never shrink or grow unless they are sized `'fill'`.

In a row, `'baseline'` lines up the first baselines of the children aligned that way, as in CSS: a text's first line, a container's first child (in a row, its first baseline-aligned child), or the bottom edge of an element without text. A row that hugs its height grows to fit them. In a column, `'baseline'` is `'start'`.

```svelte
<div style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
	<p style={{ fontSize: 24, fontWeight: 600 }}>Issues</p>
	<p style={{ fontSize: 13, color: '#71717a' }}>128 open</p>
</div>
```

### Sizing

Each axis of each element is sized one of three ways:

- **Fixed** (a number): exactly that many pixels. Padding is included, so `width: 100, padding: 10` leaves 80 for content.
- **`hug`** (the default): the size of the content plus padding.
  - Text that hugs its width stays on one line and never wraps. It breaks only at `\n` characters in expression values. If the parent is too narrow, it overflows. [Truncated](#truncation-text-elements-only-not-inherited) text is the exception: it wraps where `maxWidth` limits it.
  - An `<input>` or `<textarea>` that ends up hugging (see below: it cannot be authored as `hug`) is the size of what it shows: its value (masked as `•` for passwords), else its placeholder, measured like text, plus padding. A textarea's height is its lines, wrapped at its width, and at least one line: an empty textarea is one line plus padding. The size follows the value as it changes.
- **`fill`**:
  - On the parent's **main axis**: the element takes an equal share of the space left after fixed and hugging siblings and gaps.
  - On the parent's **cross axis**: the element stretches to the parent's inner size. This overrides `alignSelf` and `alignItems` for that axis.
  - Text with `width` set to `'fill'` or a number wraps at spaces.

`min*` and `max*` clamp the result of all three modes, `fill` included. Clamping can make an element overflow its parent.

When the parent hugs the axis that its child fills, the parent has no space to give:

- **Main axis:** the child is sized by its content, as if it hugged.
- **Cross axis:** the child stretches to the largest sibling. An only flow child is sized by its content.

A child sized by its content this way is a hugging parent to its own children, so the rule applies all the way down.

```svelte
<div style={{ flexDirection: 'row', width: 'fill', gap: 8, alignItems: 'center' }}>
	<input style={{ width: 'fill' }} bind:value={draft} />  <!-- takes the remaining width -->
	<button style={button}>Add</button>                      <!-- hugs -->
</div>
```

### Spacing, borders, and clipping

- `padding` insets the content. `gap` separates flow children.
- `justifyContent: 'space-between'` spreads children across the main axis.
- `flexWrap: 'wrap'` wraps children onto new lines, which are separated by the same `gap`.
- Margins act like flex-item margins. An `'auto'` margin absorbs free space, so `margin: [0, 'auto']` centers an element on a row's main axis. Negative margins are allowed.
- **Borders do not affect layout.** A border is drawn inside the element's box, on top of the padding area, on all four sides, as a solid line. Setting `borderColor` without `borderWidth` draws nothing.
- `borderRadius` rounds the corners of the background, border, and shadow. `overflow: 'hidden'` clips children to the box, including its radius. Inputs always clip.

### Scrolling

`'auto'` and `'scroll'` make a container a scroll container on that axis: content that does not fit is clipped and can be scrolled to. `'auto'` shows a scrollbar only when there is something to scroll; `'scroll'` always reserves one where the platform draws them.

```svelte
<main style={{ width: 'fill', height: 'fill' }}>
	<div style={{ width: 'fill', height: 'fill', overflowY: 'auto' }}>…long list…</div>
	<div style={{ width: 'fill', padding: 12 }}>Composer stays visible</div>
</main>
```

- A container only scrolls when it is smaller than its content, so give it a fixed size, `'fill'`, or a `max` size on that axis. One that hugs its content has nothing to scroll.
- An axis left unset is `'visible'`, but when the other axis is not `'visible'` it behaves as `'auto'`, as in CSS. Writing `'visible'` on one axis together with `'hidden'`, `'auto'` or `'scroll'` on the other is an error, because the browser would not keep that axis visible.
- Content can only be scrolled to on the end side. Content that overflows the start side, for example with `justifyContent: 'end'`, `'center'` or `alignItems: 'end'`, is cut off. To keep short content at the end and still scroll long content, use an `'auto'` margin on it instead, such as `marginTop: 'auto'`.
- The scroll position is not state. It belongs to the browser, starts at the beginning, and is not part of overrides or snapshots. To move it, call the element's own API from a handler or `$effect`, for example `el.scrollIntoView()` on an element from [`bind:this`](#bindthis).
- In a Figma snapshot a scroll container is a clipped frame showing its content from the start.
- `opacity` applies to the element together with its contents.
- Paint order follows source order: later siblings paint above earlier ones. There is no `zIndex`; render an element into a [portal](#portals) to paint it above other content.

### Absolute positioning

```svelte
<div style={{ width: 200, height: 120 }}>
	<div style={{ position: 'absolute', left: 8, top: 8, width: 24, height: 24, background: '#ef4444' }}></div>
</div>
```

- An absolute element leaves the flow. It does not affect its siblings or its parent's hug size.
- `left` and `top` are measured from the parent's outer top-left corner, ignoring the parent's padding. An omitted side keeps the position the element would have as the parent's only flow child.
- Absolute elements are positioned relative to their direct parent, unless they are [anchored](#anchored-positioning). `right`, `bottom`, and `fill` sizing are not available.

### Anchored positioning

An absolute element can be anchored to another element: its position is derived from where that element is rendered, wherever the two are in the tree and whatever their rendered parents are. The anchor is an element from [`bind:this`](#bindthis), given in the `anchor` style property:

```svelte
<script lang="ts">
	let open = $state(false);
	let trigger = $state<HTMLButtonElement>();
</script>
<button bind:this={trigger} onclick={() => (open = !open)}>Labels</button>
{#if open}
	<div
		portal="overlay"
		style={{
			position: 'absolute',
			anchor: trigger,
			anchorPosition: 'bottom-start',
			anchorOffset: 6,
			anchorPadding: 8,
			width: 'anchor',
			maxHeight: 'available',
			overflowY: 'auto'
		}}
	>…</div>
{/if}
```

- **Placement.** `anchorPosition` is the side of the anchor the element goes on, and how it lines up along that side: `'bottom-start'` puts it below with their start (left) edges aligned, `'bottom-end'` aligns their end edges, and `'bottom'` centers it. `'left-start'` puts it on the left with their top edges aligned, and so on. `anchorOffset` is the gap between the two along the main axis (below, for `'bottom-start'`). `anchorCrossOffset` moves it along the other axis from where it lines up (right, for `'bottom-start'`; negative values move it the other way).
- **Collisions.** The element stays inside the viewport inset by `anchorPadding`, the *boundary*. Two things happen, in this order:
  - *Flip:* the placements are tried in order, `anchorPosition` first, then `anchorFallbacks`. The first one where the element fits along its main axis wins. When none fits, the one with the most room along its main axis wins, the earliest among equals. Without `anchorFallbacks`, the fallback is the opposite side with the same alignment (`'bottom-start'` falls back to `'top-start'`). `anchorFallbacks: []` never flips.
  - *Shift:* along the side, the element is moved to stay inside the boundary instead of flipping. An element larger than the boundary keeps its start edge inside. The main axis is never shifted, so an element that fits on no side overflows on its chosen side; give it `maxWidth`/`maxHeight: 'available'` to keep it in.
  - The same geometry and options always give the same result.
- **Sizing.** `width: 'anchor'` and `height: 'anchor'` match the anchor's current width and height. `maxWidth: 'available'` and `maxHeight: 'available'` limit the element to the room it has at the chosen placement: along the main axis, from the anchor (past `anchorOffset`) to the boundary; across it, the whole boundary. The placement is chosen for the element's size without that limit.
- **Updates.** The position and sizes follow the anchor's rendered box and the element's own size, and stay correct when either one moves or changes size, when the layout reflows, when the viewport resizes, when anything scrolls, and when the element moves to another portal. You never measure or listen for anything yourself, and there is nothing to turn on.
- **Detachment.** While the anchor is not rendered, or is scrolled or clipped completely out of view (by the viewport or a clipping ancestor such as a scroll container), the anchored element is hidden. It comes back when the anchor does.
- **The reference.** `anchor` takes an element from `bind:this`, or an element from an event saved in `$state` (`menu = { trigger: event.currentTarget as HTMLElement }`), which is how one menu anchors to whichever button opened it. A nullish `anchor` means "anchored to nothing yet": the element is hidden. Unlike other properties, it is kept when nullish, so the anchor rules still apply and it overrides an earlier `anchor`. A `bind:this` variable is state, so the style is evaluated again when the anchor mounts, even when it comes after the anchored element.
- Anchoring works with or without a [portal](#portals). The element is still absolutely positioned inside its rendered parent, so it scrolls with that parent and is clipped by it (`overflow: 'hidden'`). To float above everything and escape clipping, render it into a portal at the end of the app, as above.

These are compile errors: `anchor` without `position: 'absolute'`, the other anchor properties without `anchor`, an unknown placement in `anchorPosition` or `anchorFallbacks`, `width`/`height: 'anchor'` or `maxWidth`/`maxHeight: 'available'` without `anchor`, and an `anchor` that certainly is not an element: a literal such as `anchor: 'trigger'`, or a name whose every value is one (`const`, or a `$state` with a literal initial value that is never set to an element).

In the browser, Patch places anchored elements itself instead of using CSS anchor positioning, so that the browser and Figma snapshots use the same geometry. In a Figma snapshot, the viewport is the 1280 × 800 frame, a `bind:this` anchor resolves to its element, and an anchored element whose anchor is missing or out of view is left out. An anchor saved from an event has no value in a snapshot, so its element is left out too.

### The root

Top-level nodes are laid out as a column inside a viewport-sized host:

- **In the browser**, the host is the full window. It has a white background and scrolls when content overflows.
- **In a Figma snapshot**, the host is a clipped 1280 × 800 frame.

`width: 'fill'` and `height: 'fill'` at the top level fill the viewport.

## Typography and inheritance

The typography properties (`color`, `fontFamily`, `fontSize`, `fontWeight`, `fontStyle`, `lineHeight`, `letterSpacing`, `textAlign`, `textDecoration`, `textTransform`) inherit from parent to child through every element kind, including inputs and inline spans. No other property inherits, except the [interaction properties](#interaction) that inherit in CSS.

```svelte
<div style={{ color: '#71717a', fontSize: 14 }}>
	<p>Inherits gray, 14px</p>
	<p>Mixed <span style={{ fontWeight: 600, color: '#18181b' }}>emphasis</span> inside one line</p>
</div>
```

- The root defaults are Inter, 16px, weight 400, normal style, line height 1.2 × font size, letter spacing 0, color `#000000`, `start` alignment, no decoration, and no transform.
- An explicit `lineHeight` is inherited as a fixed pixel value.
- Input placeholders use the current text color at 50% opacity.
- Browser outputs load Inter from Google Fonts, which needs network access. Any other `fontFamily` must be installed on the machine that views the app. Figma snapshots measure text with locally installed font files, and fall back to a substitute font with a warning.

## Design-time state and snapshots

```sh
patch dev app.pat                       # browser, live reload; effects run
patch build app.pat [out.html]          # standalone HTML; effects run
patch snapshot html app.pat [out.html] [--state name=value]...
patch snapshot figma app.pat [--state name=value]...
```

A snapshot renders the app from its **initial state**, with optional overrides, **without running `$effect`s**.

### State overrides

`--state name=value` replaces the initial value of a top-level `$state` named `name`:

- Only `$state` variables can be overridden. A `$derived` cannot, and it is computed from the overridden state.
- Unknown names are errors, and the error lists the available names.
- The value is parsed as JSON. If parsing fails, it is used as a plain string.
- In a `lang="ts"` script, each candidate is checked against the variable's **declared** type: the JSON reading first, then the raw string. The first one that fits is used. If none fits, the type error is reported.
  ```sh
  --state filter=done                       # "done"  (not valid JSON)
  --state count=3                           # 3
  --state label=123                         # "123" when `label` is a string
  --state 'label="quoted"'                  # "quoted"
  --state 'tasks=[{"id":1,"done":true}]'    # an array
  --state selected=null                     # null, if the type allows it
  ```
- In a JS script, the value is used as JSON if it parses, and as a string otherwise, without any checking.
- The initializer expression of an overridden state does not run.

### State of component instances

State declared in a component is overridden per instance. Its id is the instance's **path** followed by the variable name:

```sh
--state 'Sidebar@14:3/expanded=true'          # the <Sidebar> written at line 14, column 3 of the app
--state 'Row@22:5[42]/expanded=true'          # the <Row> in the {#each} item keyed 42
--state 'Row@22:5[0]/expanded=true'           # in an unkeyed {#each}: the item at index 0
--state 'Card@8:2/Toggle@3:4/on=true'         # a <Toggle> inside the <Card> at 8:2
```

- Each step of the path is `Tag@line:column`, where the tag is written, followed by the `[key]` of every `{#each}` item around the tag (in that file), outermost first. Keys are written as JSON (`[42]`, `["a"]`); an unkeyed list's key is the index. Steps are separated by `/`.
- Content rendered through `{@render}` (snippets and `children`) adds a step `line:column[keys]` for the `{@render}` tag, inside the instance rendering it: `Card@8:2/5:3/Toggle@12:4/on` is a `<Toggle>` written at 12:4 in the content of the `<Card>`, rendered by the `{@render}` at 5:3 of `Card.pat`.
- An id names one instance. A path whose instance is not rendered overrides nothing.
- The value is parsed and type-checked against the variable in the component that declares it, as above. An unknown id is an error that lists the overridable state, with `[<key>]` where a key goes and `…/` where the path continues from an enclosing component.

The same paths name the nodes of a snapshot: in a Figma snapshot, a node's id is its instance path, its own `line:column`, and its `{#each}` keys.

### Snapshot targets

| | `snapshot html` | `snapshot figma` |
| --- | --- | --- |
| Output | one standalone HTML file (default `<name>.snapshot.html`) | editable layers copied to the clipboard |
| Runs in | the browser | Bun (no DOM) |
| Interactive | yes: handlers run and state updates | no |
| `$effect` | starts at the first interaction | never runs |
| Inputs | real inputs | frames showing the value (passwords masked as `•`) or the placeholder at 50% opacity |

The Figma target approximates what Figma cannot express, and prints a warning each time:

- wrapping in columns is not applied
- negative margins are dropped
- auto margins on absolute elements are dropped
- a hugging-width text with a set height is given a fixed width

Without a warning, a snapshot also keeps a character whose uppercase or lowercase form is longer as it is: `textTransform: 'uppercase'` shows `ß` as `SS` in the browser but as `ß` in Figma until the layer is edited.

## Unsupported constructs

| Construct | Use instead |
| --- | --- |
| `<style>`, `class=`, `class:`, CSS strings in `style=`, `style:` | `style={{ ... }}`, `$style`, arrays |
| `export` from a `.pat` file | [`$props()`](#props) for inputs, a `.ts` module for shared code |
| `{#await}` | `$state` plus an `async` function or `$effect` |
| `{:else}` in `{#each}` | `{#if list.length === 0}` |
| destructured `{#each}` items | `{#each list as item (item.id)}` |
| `{#key}`, `{@html}`, `{@const}`, `{@debug}`, `{@attach}` | none |
| `bind:` other than `bind:value` on inputs and `bind:this`; `bind:` on components, `$bindable` | `value=` plus a handler; a prop plus a [callback prop](#props) |
| slots, named slots, `<svelte:fragment>` | [`children`](#children) and snippet props |
| component events, lifecycle functions (`onMount`, …), component refs and methods | callback props, `$effect` |
| `on:click` / `onClick` | `onclick` |
| transitions, animations, actions (`use:`) | none |
| spread attributes, arbitrary HTML attributes | none |
| `$state.raw`, `$inspect`, stores (`$x`) | none |
| DOM manipulation and measurement | template and `style` |
| CSS grid, `z-index`, `right`/`bottom`, percentages, units, named colors, gradients, images, per-side borders, transforms | none |

## Open questions

Semantics that are documented as they behave today but have not been settled.

1. **Should `''` be skipped in a style expression like other falsy values?** Today it is a compile error ([Composition and merging](#composition-and-merging)).
2. **Should `false` interpolate the same in attributes as in text?** `{false}` renders as nothing in text, but `"a {false}"` in an attribute renders `"a false"` ([Text and whitespace](#text-and-whitespace), [Attributes](#attributes)).
