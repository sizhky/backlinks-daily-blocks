# Collapsed section state

User report, 2026-07-27: When Done is collapsed, moving a Doing task to Done expands Done.

Runtime trace at revision `81fb764` used the actual `DoingView.moveTask` method with a successful move:

```text
before move: done collapsed=true
draw: done collapsed=false
```

Source inspection identifies `this.collapsed.delete(toCol.key)` in `src/views/doing.js` as the state change between these observations.
