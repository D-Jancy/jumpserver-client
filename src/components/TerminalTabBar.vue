<template>
  <div class="tab-bar" ref="tabBarRef">
  <!-- 左侧渐变遮罩 -->
  <div class="tab-bar-fade tab-bar-fade--left" :class="{ visible: canScrollLeft }"></div>

  <!-- 左滚按钮 -->
  <button
    v-show="canScrollLeft"
    class="tab-scroll-btn tab-scroll-btn--left"
    @click="scrollTabs('left')"
    title="向左滚动"
  >
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M6 2L3 5L6 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </button>

  <!-- Tab 列表容器 -->
  <div
    class="tab-strip"
    ref="tabStripRef"
    @wheel.prevent="onWheel"
    @mousedown="onStripMouseDown"
  >
    <div
      v-for="tab in tabs"
      :key="tab.id"
      class="tab-item"
      :class="{
        'tab-active': tab.id === activeTabId,
        'dragging': dragTabId === tab.id
      }"
      :draggable="true"
      @click="selectTab(tab.id)"
      @auxclick.prevent="closeTab(tab.id)"
      @dragstart="onDragStart($event, tab)"
      @dragover.prevent="onDragOver($event, tab)"
      @dragleave="onDragLeave"
      @drop="onDrop($event, tab)"
      @dragend="onDragEnd"
    >
      <!-- 连接状态指示器 -->
      <span class="tab-status" :class="{ connected: tab.connected }"></span>

      <!-- Tab 标题 -->
      <span class="tab-label">{{ tab.title }}</span>

      <!-- 地址提示 -->
      <!-- <span class="tab-address" v-if="tab.assetAddress">{{ tab.assetAddress }}</span> -->

      <!-- 关闭按钮 -->
      <button class="tab-close" @click.stop="closeTab(tab.id)" title="关闭">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  </div>

  <!-- 右滚按钮 -->
  <button
    v-show="canScrollRight"
    class="tab-scroll-btn tab-scroll-btn--right"
    @click="scrollTabs('right')"
    title="向右滚动"
  >
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M4 2L7 5L4 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </button>

  <!-- 右侧渐变遮罩 -->
  <div class="tab-bar-fade tab-bar-fade--right" :class="{ visible: canScrollRight }"></div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useAppStore } from '../stores/app'

const appStore = useAppStore()

const emit = defineEmits(['select-tab', 'close-tab', 'new-tab'])

const tabBarRef = ref(null)
const tabStripRef = ref(null)
const canScrollLeft = ref(false)
const canScrollRight = ref(false)

// 拖拽状态
const dragTabId = ref(null)
const dragOverTabId = ref(null)

const tabs = computed(() => appStore.tabs)
const activeTabId = computed(() => appStore.activeTabId)

function selectTab(tabId) {
  appStore.setActiveTab(tabId)
}

function closeTab(tabId) {
  // 断开该 tab 的 SSH
  window.electronAPI.disconnectSSH(tabId)
  appStore.closeTab(tabId)
}

function onWheel(e) {
  if (!tabStripRef.value) return
  // 同时支持垂直滚轮 (deltaY) 和水平滚轮/触控板 (deltaX)
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
  if (delta !== 0) {
    tabStripRef.value.scrollLeft += delta
    updateFadeState()
  }
}

// 鼠标按住拖动滚动（tab-strip 空白区域）
let dragScrollState = null

function onStripMouseDown(e) {
  // 仅响应鼠标左键
  if (e.button !== 0) return
  // 点击在 tab-item 内部时不处理（让 tab 自己处理点击/拖拽）
  if (e.target.closest('.tab-item')) return
  // 仅当 tab 多到能滚动时才启用
  if (!tabStripRef.value) return
  if (tabStripRef.value.scrollWidth <= tabStripRef.value.clientWidth) return

  dragScrollState = {
    startX: e.clientX,
    startScrollLeft: tabStripRef.value.scrollLeft,
    moved: false
  }
  document.addEventListener('mousemove', onDragScrollMove)
  document.addEventListener('mouseup', onDragScrollEnd, { once: true })
}

function onDragScrollMove(e) {
  if (!dragScrollState || !tabStripRef.value) return
  const dx = e.clientX - dragScrollState.startX
  if (Math.abs(dx) > 3) {
    dragScrollState.moved = true
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
  }
  if (dragScrollState.moved) {
    tabStripRef.value.scrollLeft = dragScrollState.startScrollLeft - dx
    updateFadeState()
  }
}

function onDragScrollEnd() {
  document.removeEventListener('mousemove', onDragScrollMove)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  // 防止拖动结束时触发误点击
  if (dragScrollState?.moved) {
    const handler = (ev) => {
      ev.stopPropagation()
      ev.preventDefault()
      document.removeEventListener('click', handler, true)
    }
    document.addEventListener('click', handler, true)
    setTimeout(() => document.removeEventListener('click', handler, true), 50)
  }
  dragScrollState = null
}

function scrollTabs(direction) {
  if (!tabStripRef.value) return
  const amount = tabStripRef.value.clientWidth * 0.6
  tabStripRef.value.scrollBy({
    left: direction === 'left' ? -amount : amount,
    behavior: 'smooth'
  })
  // 滚动动画期间多次更新遮罩状态
  setTimeout(updateFadeState, 50)
  setTimeout(updateFadeState, 200)
  setTimeout(updateFadeState, 400)
}

function updateFadeState() {
  if (!tabStripRef.value) return
  const el = tabStripRef.value
  canScrollLeft.value = el.scrollLeft > 2
  canScrollRight.value = el.scrollLeft < el.scrollWidth - el.clientWidth - 2
}

// 拖拽排序
function onDragStart(e, tab) {
  dragTabId.value = tab.id
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', tab.id)
}

function onDragOver(e, tab) {
  if (!dragTabId.value || dragTabId.value === tab.id) return
  dragOverTabId.value = tab.id
}

function onDragLeave() {
  dragOverTabId.value = null
}

function onDrop(e, targetTab) {
  if (!dragTabId.value || dragTabId.value === targetTab.id) return

  const allTabs = [...appStore.tabs]
  const dragIdx = allTabs.findIndex(t => t.id === dragTabId.value)
  const dropIdx = allTabs.findIndex(t => t.id === targetTab.id)
  if (dragIdx === -1 || dropIdx === -1) return

  const [moved] = allTabs.splice(dragIdx, 1)
  allTabs.splice(dropIdx, 0, moved)
  appStore.tabs.splice(0, appStore.tabs.length, ...allTabs)

  dragOverTabId.value = null
}

function onDragEnd() {
  dragTabId.value = null
  dragOverTabId.value = null
}

watch(() => appStore.tabs.length, () => {
  nextTick(updateFadeState)
})

watch(() => appStore.tabs, () => {
  nextTick(updateFadeState)
}, { deep: true })

watch(activeTabId, () => {
  // 切换 tab 后自动滚动到可见区域
  nextTick(() => {
    if (!tabStripRef.value) return
    const activeEl = tabStripRef.value.querySelector('.tab-active')
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    }
    setTimeout(updateFadeState, 200)
    setTimeout(updateFadeState, 400)
  })
})

onMounted(() => {
  nextTick(updateFadeState)
})
</script>

<style scoped>
.tab-bar {
  display: flex;
  align-items: stretch;
  height: 35px;
  background: var(--tab-inactive-bg);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
}

/* 渐变遮罩 */
.tab-bar-fade {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 24px;
  pointer-events: none;
  z-index: 2;
  opacity: 0;
  transition: opacity 0.15s;
}
.tab-bar-fade.visible {
  opacity: 1;
}
.tab-bar-fade--left {
  left: 0;
  background: linear-gradient(to right, var(--tab-inactive-bg), transparent);
}
.tab-bar-fade--right {
  right: 0;
  background: linear-gradient(to left, var(--tab-inactive-bg), transparent);
}

/* 左右滚动按钮 */
.tab-scroll-btn {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  cursor: pointer;
  z-index: 3;
  transition: background 0.1s, color 0.1s;
  flex-shrink: 0;
}
.tab-scroll-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.tab-scroll-btn--left {
  left: 0;
}
.tab-scroll-btn--right {
  right: 0;
}

/* Tab 条 */
.tab-strip {
  display: flex;
  flex: 1;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  cursor: grab;
}
.tab-strip:active {
  cursor: grabbing;
}
.tab-strip::-webkit-scrollbar {
  width: 0;
  height: 0;
}

/* 单个 Tab */
.tab-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  height: 100%;
  min-width: 0;
  max-width: 200px;
  cursor: pointer;
  border-right: 1px solid var(--border-color);
  background: var(--tab-inactive-bg);
  color: var(--text-secondary);
  font-size: 12px;
  user-select: none;
  position: relative;
  flex-shrink: 0;
  transition: background 0.1s;
}
.tab-item:hover {
  background: var(--bg-hover);
}
.tab-item.tab-active {
  background: var(--tab-active-bg);
  color: var(--text-primary);
}
.tab-item.tab-active::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--tab-active-border);
}
.tab-item.dragging {
  opacity: 0.4;
}

.tab-status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
  transition: background 0.2s;
}
.tab-status.connected {
  background: var(--success);
}

.tab-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
  min-width: 0;
}

.tab-address {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
}

.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.1s, background 0.1s;
}
.tab-item:hover .tab-close,
.tab-item.tab-active .tab-close {
  opacity: 0.7;
}
.tab-close:hover {
  opacity: 1 !important;
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}
</style>
