import { describe, expect, test } from 'bun:test'
import mustache from 'mustache'
import { buildBloodMessageView } from '../../../../apps/api/src/services/bloodbot-view'
import { ServerConfigSchema } from '../../../../packages/config/src/types'

const baseConfig = {
  ctfName: 'rCTF',
  origin: 'https://ctf.example.com',
  tokenKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  database: {
    sql: 'postgres://test:test@localhost:5432/test',
    redis: 'redis://localhost:6379',
  },
  startTime: 0,
  endTime: 99999999999999,
}

describe('blood bot', () => {
  test('stores blood emojis per destination', () => {
    const discordEmojis = [
      '<:rank1:1008801500736266261>',
      '<:rank2:1008801501776449738>',
      '<:rank3:1008801503080874056>',
    ]
    const telegramEmojis = [':first:', ':second:', ':third:']

    const parsed = ServerConfigSchema.parse({
      ...baseConfig,
      bloodBot: {
        bloodsCount: 3,
        destinations: [
          {
            provider: {
              name: 'messages/discord',
              options: {
                url: 'https://discord.com/api/webhooks/123/abc',
              },
            },
            bloodEmojis: discordEmojis,
          },
          {
            provider: {
              name: 'messages/telegram',
              options: {
                botToken: '123456:abcdef',
                chatId: '-1001234567890',
              },
            },
            bloodEmojis: telegramEmojis,
          },
        ],
      },
    })

    expect(parsed.bloodBot?.destinations[0]?.bloodEmojis).toEqual(discordEmojis)
    expect(parsed.bloodBot?.destinations[1]?.bloodEmojis).toEqual(
      telegramEmojis
    )
  })

  test('renders blood emoji and word-based solve position variables', () => {
    const view = buildBloodMessageView({
      user: {
        id: 'team-1',
        name: 'libteam.so.1',
      },
      challenge: {
        category: 'misc',
        name: 'Captivating Canvas Contraption',
      },
      bloodNumber: 1,
      bloodEmojis: [
        '<:rank1:1008801500736266261>',
        '<:rank2:1008801501776449738>',
        '<:rank3:1008801503080874056>',
      ],
      origin: 'https://ctf.example.com',
      provider: {
        escapeText: value => value,
        escapeUrl: value => value,
      },
    })

    const message = mustache.render(
      '{{bloodEmoji}} {{bloodNumTitle}} solve for challenge "**{{challengeName}}**" goes to **{{teamName}}**!',
      view,
      {},
      { escape: (value: string) => value }
    )

    expect(view.bloodNumWord).toBe('first')
    expect(view.bloodNumTitle).toBe('First')
    expect(view.bloodNumOrdinal).toBe('1st')
    expect(message).toBe(
      '<:rank1:1008801500736266261> First solve for challenge "**Captivating Canvas Contraption**" goes to **libteam.so.1**!'
    )
  })
})

test('frozen blood templates preserve challenge, position, and emoji without solver identity', () => {
  const view = buildBloodMessageView({
    user: { id: 'private-team-id', name: 'Private Team Name' },
    challenge: { category: 'web', name: 'Example challenge' },
    bloodNumber: 2,
    bloodEmojis: ['gold', 'silver', 'bronze'],
    origin: 'https://ctf.example.com',
    provider: { escapeText: value => value, escapeUrl: value => value },
    maskSolver: true,
  })
  const message = mustache.render(
    '{{teamName}} {{teamUrl}} {{challengeName}} {{bloodNumOrdinal}} {{bloodEmoji}}',
    view
  )
  expect(view.teamName).toBe('??')
  expect(view.teamUrl).toBe('https://ctf.example.com/scores')
  expect(view.challengeName).toBe('Example challenge')
  expect(view.bloodNumOrdinal).toBe('2nd')
  expect(view.bloodEmoji).toBe('silver')
  expect(message).toContain('Example challenge 2nd silver')
  expect(message).not.toContain('/profile/')
  expect(message).not.toContain('private-team-id')
  expect(message).not.toContain('Private Team Name')
})

test('division changes default to disabled and require explicit opt-in', () => {
  expect(ServerConfigSchema.parse(baseConfig).allowDivisionChanges).toBe(false)
  expect(
    ServerConfigSchema.parse({ ...baseConfig, allowDivisionChanges: true })
      .allowDivisionChanges
  ).toBe(true)
})
