export function createContextInspectorState() {
  return {
    open: false,
    selection: null,
    closedByUser: false,
    busy: false,
  };
}

export function selectContextInspector(current, selection) {
  if (!selection?.type || !selection?.id) return current;
  return {
    ...current,
    open: true,
    selection: { ...selection },
    closedByUser: false,
  };
}

export function closeContextInspector(current) {
  if (current.busy) return current;
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

export function setContextInspectorBusy(current, busy) {
  return {
    ...current,
    busy: Boolean(busy),
  };
}
