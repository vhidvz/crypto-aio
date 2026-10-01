<script setup lang="ts">
// The default layout, plus what config.mts adds to a page's front matter: a step of the
// learning path opens with its step header, and a moved page sends the reader on.
import { inBrowser, useData, withBase } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { watchEffect } from 'vue';
import LessonMeta from './LessonMeta.vue';

const { Layout } = DefaultTheme;
const { frontmatter } = useData();

// A moved page's <head> already redirects; this covers arriving by in-site navigation.
watchEffect(() => {
  const target: unknown = frontmatter.value.redirectLink;
  if (inBrowser && typeof target === 'string') window.location.replace(withBase(target));
});
</script>

<template>
  <Layout>
    <template #doc-before>
      <LessonMeta v-if="frontmatter.lesson" :lesson="frontmatter.lesson" />
    </template>
  </Layout>
</template>
