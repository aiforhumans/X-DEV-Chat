const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

export const formatTime = (value: string): string => timeFormatter.format(new Date(value))

export const formatDateTime = (value: string): string => dateTimeFormatter.format(new Date(value))
