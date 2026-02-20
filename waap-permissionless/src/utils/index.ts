export const truncateDecimals = (
  value: number | string,
  decimals = 6
): number => {
  const [integerPart, decimalPart] = value.toString().split('.')

  return parseFloat(
    `${integerPart}.${decimalPart?.slice(0, decimals) || '0000'}`
  )
}

export const truncateAddress = (addr: string) => {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (error) {
    console.error('Failed to copy to clipboard:', error)
    return false
  }
}