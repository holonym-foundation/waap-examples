import { useToast } from './useToast'

export function useCopyToClipboard() {
  const notify = useToast()

  const copyToClipboard = async (text: string, label: string = 'Text') => {
    try {
      await navigator.clipboard.writeText(text)
      notify('success', `${label} copied to clipboard`)
      return true
    } catch (error) {
      console.error('Failed to copy to clipboard:', error)
      notify('error', 'Failed to copy to clipboard')
      return false
    }
  }

  return { copyToClipboard }
}
