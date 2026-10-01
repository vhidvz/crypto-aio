<script setup lang="ts">
// The header of a step of the learning path: its part, the step and a progress bar, and the
// reading time. config.mts works these out from docs/.vitepress/navigation.ts, so pages never
// hard-code "step 3 of 9".
defineProps<{
  lesson: { part: string; unit: string; step: number; steps: number; minutes: number };
}>();
</script>

<template>
  <div class="lesson-meta">
    <span class="lesson-part">{{ lesson.part }}</span>
    <span>{{ lesson.unit }} {{ lesson.step }} of {{ lesson.steps }}</span>
    <span>About {{ lesson.minutes }} min</span>
    <div class="lesson-progress" aria-hidden="true">
      <span :style="{ width: `${(100 * lesson.step) / lesson.steps}%` }" />
    </div>
  </div>
</template>
