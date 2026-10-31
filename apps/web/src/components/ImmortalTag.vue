<template>
  <span class="immortal-rank" title="飞升成仙 · 战力 ×6">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1 10 6 15 8 10 10 8 15 6 10 1 8 6 6Z" /></svg>
    仙人
  </span>
</template>

<style scoped>
.immortal-rank {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border: 1px solid rgba(247, 211, 137, 0.7);
  border-radius: 3px;
  background: linear-gradient(115deg, rgba(181, 122, 34, 0.24), rgba(247, 211, 137, 0.08));
  color: #ffe4a4;
  box-shadow: inset 0 0 5px rgba(247, 211, 137, 0.1), 0 0 8px rgba(247, 211, 137, 0.12);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
}
.immortal-rank svg {
  width: 11px;
  height: 11px;
  fill: currentColor;
}
</style>
