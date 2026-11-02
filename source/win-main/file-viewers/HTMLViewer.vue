<template>
  <div
    ref="htmlViewerContainer"
    class="html-viewer-container"
    role="region"
    v-bind:aria-label="`HTMLViewer: Currently viewing file ${pathBasename(props.file.path)}`"
    v-on:pointerenter="acceptsClicks = true"
    v-on:pointerleave="acceptsClicks = false"
  >
    <iframe
      ref="iframe"
      v-bind:src="makeValidUri(props.file.path)" view="Fit"
      v-bind:class="{ 'pointer-events': acceptsClicks }"
    ></iframe>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        HTMLViewer
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     The HTML Viewer is a component that can be mounted into
 *                  editor panes to display HTML files, using Chromium's built-in
 *                  HTML viewer. NOTE that due to the way iframes work, we have
 *                  to manually enable and disable pointer events. Were we not
 *                  doing this, the iframes could "swallow" drag events, making
 *                  resizing of the editor panes using the resizer bars cumbersome.
 *                  Currently, the pointer events are enabled or disabled based
 *                  on `pointerenter` and `pointerleave` events.
 *
 * END HEADER
 */
import type { OpenDocument } from 'source/types/common/documents'
import type { EditorCommands } from '../App.vue'
import makeValidUri from 'source/common/util/make-valid-uri'
import { ref } from 'vue'
import { pathBasename } from 'source/common/util/renderer-path-polyfill'

const props = defineProps<{
  leafId: string
  windowId: string
  activeFile: OpenDocument|null
  editorCommands: EditorCommands
  file: OpenDocument
}>()

const iframe = ref<HTMLIFrameElement|null>(null)
const htmlViewerContainer = ref<HTMLDivElement|null>(null)
const acceptsClicks = ref(false)

</script>

<style lang="css" scoped>
div.html-viewer-container {
  width: 100%;
  height: 100%;
  user-select: auto;
  overflow: hidden;

  iframe {
    width: 100%;
    height: 100%;
    border: 1px solid transparent;
    pointer-events: none;

    &.pointer-events {
      pointer-events: auto;
    }
  }
}
</style>
