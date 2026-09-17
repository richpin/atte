Use relative imports within a slice, and absolute imports through public APIs across slices

Follow Solid's fine-grained reactivity model. Do not apply React re-render patterns to Solid components.
Remember that component functions normally execute once. Put reactive logic inside reactive scopes rather than expecting the component body to re-run.
Keep reactive reads inside tracked scopes such as JSX, derived accessors, memos, and effects.
Do not mirror derived state into writable signals with effects.
Use a plain derived accessor for simple derived values and createMemo when memoization is useful.
Keep createMemo pure. Do not perform side effects or write reactive state inside memos.
Use createEffect only for genuine side effects. Avoid writing signals from effects unless the design explicitly requires it.
Use onMount for one-time setup and onCleanup for listeners, timers, subscriptions, and external resources.
Do not destructure reactive props. Read them through props, or use splitProps / mergeProps.
Treat props as read-only and preserve one-way data flow.
Prefer createSignal for simple independent state and createStore for structured or deeply nested state.
Update stores through their setters and path syntax rather than bypassing the store API.
Use Context for genuinely shared tree-level state, not automatically as a replacement for ordinary props.
Prefer Solid control-flow primitives for reactive UI.
Use <For> for lists whose order or length changes and <Index> when indexes remain stable while values change frequently.
Prefer ref over DOM selector queries when accessing elements owned by a component.
Use createResource when asynchronous data fits a reactive loading/error/data lifecycle.
Do not add manual batch calls unless multiple updates actually require batching; Solid already batches several common cases.
Do not use createComputed for ordinary derived application state.
Use untrack only when intentionally excluding a reactive dependency.

## UI and Styling

Prefer existing Solid UI components for common UI patterns. Use Kobalte primitives when a suitable Solid UI component is unavailable or custom behavior is required.
Use Tailwind CSS for styling and customization.
Keep reusable UI components under shared/ui and reuse them across features.
Use semantic design tokens and centralized variants instead of duplicating arbitrary Tailwind styles.
Preserve the accessibility and interaction behavior provided by Solid UI and Kobalte.
