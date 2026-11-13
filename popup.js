// 彈窗設定：寫入 storage.sync，內容腳本透過 onChanged 即時重建
const DEFAULTS = { enabled: false, position: 'below' }
const toggle = document.getElementById('toggle')
const position = document.getElementById('position')

chrome.storage.sync.get(DEFAULTS).then((settings) => {
  toggle.checked = settings.enabled
  position.value = settings.position
})

toggle.addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: toggle.checked })
})

position.addEventListener('change', () => {
  chrome.storage.sync.set({ position: position.value })
})
