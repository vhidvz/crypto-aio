<script setup lang="ts">
// A ```mermaid fence (config.mts turns each into this component), drawn in the browser in the
// reader's light or dark theme, and drawn again when they switch.
import { useData } from 'vitepress';
import { nextTick, onMounted, ref, useId, useTemplateRef, watch } from 'vue';

/** A diagram shrinks to fit the page down to this width, then scrolls (on a phone). */
const MIN_WIDTH = 560;

const props = defineProps<{ code: string }>();
const { isDark } = useData();
const id = `mermaid-${useId()}`;
const container = useTemplateRef<HTMLElement>('container');
const svg = ref('');
const failed = ref(false);
let draws = 0;

async function draw(): Promise<void> {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: isDark.value ? 'dark' : 'neutral',
    fontFamily:
      'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    flowchart: { htmlLabels: true, curve: 'basis' },
    sequence: { mirrorActors: false, showSequenceNumbers: false },
  });
  try {
    svg.value = (
      await mermaid.render(`${id}-${++draws}`, decodeURIComponent(props.code))
    ).svg;
    failed.value = false;
    await nextTick();
    const drawn = container.value?.querySelector('svg');
    const width = drawn?.viewBox.baseVal?.width ?? 0;
    if (drawn && width > 0) drawn.style.minWidth = `${Math.min(width, MIN_WIDTH)}px`;
  } catch (error) {
    console.error(error);
    failed.value = true;
  }
}

onMounted(draw);
watch(isDark, draw);
</script>

<template>
  <pre v-if="failed" class="mermaid-source">{{ decodeURIComponent(code) }}</pre>
  <div v-else ref="container" class="mermaid-diagram" v-html="svg" />
</template>
