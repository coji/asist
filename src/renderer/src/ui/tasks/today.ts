import { useEffect, useState } from 'react'
import { dayKeyOf } from '@shared/tasks'

/** Today's day key, which every due date is judged against. It is read again every minute, so it moves on at midnight. */
export function useToday(): string {
  const [today, setToday] = useState(() => dayKeyOf(new Date()))
  useEffect(() => {
    const timer = setInterval(() => setToday(dayKeyOf(new Date())), 60_000)
    return () => clearInterval(timer)
  }, [])
  return today
}
