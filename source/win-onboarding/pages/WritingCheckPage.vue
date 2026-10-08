<template>
  <h1>{{ pageHeading }}</h1>
  <p>{{ intro }}</p>
  <p>{{ instructions }}</p>
</template>

<script setup lang="ts">
import { trans } from 'source/common/i18n-renderer'

const pageHeading = trans('Check your writing')
const intro = trans('Zettlr supports language servers for spelling, grammar, and Markdown checks. You can use LTeX+, codebook, panache, or another compatible server.')
const instructions = trans('Enable bundled panache, codebook, and LTeX+ in Preferences → Language servers, or configure your own installed servers.')
</script>
