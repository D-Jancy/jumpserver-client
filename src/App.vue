<template>
  <n-config-provider :theme="currentTheme" :locale="zhCN" :date-locale="dateZhCN">
    <n-message-provider>
      <n-loading-bar-provider>
        <SetupForm v-if="!isConfigured" @configured="onConfigured" />
        <MainLayout v-else @logout="onLogout" />
      </n-loading-bar-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { NConfigProvider, NMessageProvider, NLoadingBarProvider, darkTheme, zhCN, dateZhCN } from 'naive-ui'
import SetupForm from './components/SetupForm.vue'
import MainLayout from './components/MainLayout.vue'
import { useAppStore } from './stores/app'

const appStore = useAppStore()
const isConfigured = ref(false)

const currentTheme = computed(() => {
  return appStore.theme === 'dark' ? darkTheme : null
})

onMounted(async () => {
  const settings = await window.electronAPI.getSettings()
  if (settings.jms_url && settings.key_id && settings.secret) {
    appStore.setSettings(settings)
    isConfigured.value = true
  }
  // 应用初始主题
  document.documentElement.setAttribute('data-theme', appStore.theme)
})

watch(() => appStore.theme, (newTheme) => {
  document.documentElement.setAttribute('data-theme', newTheme)
})

function onConfigured() {
  isConfigured.value = true
}

async function onLogout() {
  // 断开所有 SSH 连接
  await window.electronAPI.disconnectAllSSH()
  // 清除凭据和用户信息
  await window.electronAPI.saveSettings({ jms_url: '', key_id: '', secret: '', user_info: null })
  appStore.clearSettings()
  isConfigured.value = false
}
</script>
