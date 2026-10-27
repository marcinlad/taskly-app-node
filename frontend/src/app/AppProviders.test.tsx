import { QueryClient, useQueryClient } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { useTheme } from 'styled-components'
import { beforeEach, expect, it, vi } from 'vitest'
import { GlobalStyles, theme } from '../design-system'
import { queryClient } from '../lib/queryClient'
import { AppProviders } from './AppProviders'

vi.mock('../design-system', () => import('../design-system/mocks'))

beforeEach(() => vi.clearAllMocks())

let seenClient: QueryClient | undefined
let seenTheme: unknown

function Probe() {
  seenClient = useQueryClient()
  seenTheme = useTheme()
  return <p>App content</p>
}

beforeEach(() => {
  seenClient = undefined
  seenTheme = undefined
})

it('renders its children', () => {
  render(
    <AppProviders client={new QueryClient()}>
      <Probe />
    </AppProviders>,
  )
  expect(screen.getByText('App content')).toBeVisible()
})

it('provides the application query client by default', () => {
  render(
    <AppProviders>
      <Probe />
    </AppProviders>,
  )
  expect(seenClient).toBe(queryClient)
})

it('provides the query client passed as a prop instead of the default', () => {
  const client = new QueryClient()
  render(
    <AppProviders client={client}>
      <Probe />
    </AppProviders>,
  )
  expect(seenClient).toBe(client)
  expect(seenClient).not.toBe(queryClient)
})

it('provides the design-system theme to styled components', () => {
  render(
    <AppProviders client={new QueryClient()}>
      <Probe />
    </AppProviders>,
  )
  expect(seenTheme).toBe(theme)
})

it('renders the global styles once', () => {
  render(
    <AppProviders client={new QueryClient()}>
      <Probe />
    </AppProviders>,
  )
  expect(GlobalStyles).toHaveBeenCalledTimes(1)
})
