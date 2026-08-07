export function createContextInspectorState() {
  return {
    open: false,
    selection: null,
    closedByUser: false,
  };
}

export function selectContextInspector(current, selection) {
  if (!selection?.type || !selection?.id) return current;
  return {
    open: true,
    selection: { ...selection },
    closedByUser: false,
  };
}

export function closeContextInspector(current) {
  return {
    ...current,
    open: false,
    closedByUser: true,
  };
}

export function clearContextInspector() {
  return createContextInspectorState();
}

export function refreshContextInspector(current) {
  return {
    ...current,
    selection: current.selection ? { ...current.selection } : null,
  };
}
