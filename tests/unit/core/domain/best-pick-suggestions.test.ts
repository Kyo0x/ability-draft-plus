import { describe, it, expect } from 'vitest'
import { computeBestPickSuggestions } from '@core/domain/best-pick-suggestions'
import type { ScanResult } from '@shared/types'
import type { SynergyLookup } from '@core/domain/types'
import type { SynergyPartner } from '@core/database/repositories/synergy-repository'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSlot(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    name: null,
    confidence: 0.95,
    hero_order: 1,
    ability_order: 1,
    is_ultimate: false,
    coord: { x: 0, y: 0, width: 50, height: 50, hero_order: 1 },
    ...overrides,
  }
}

function makeDetailsMap(
  entries: { name: string; displayName: string; isUltimate?: boolean }[],
): Map<string, { displayName: string; isUltimate: boolean }> {
  const map = new Map<string, { displayName: string; isUltimate: boolean }>()
  for (const e of entries) {
    map.set(e.name, { displayName: e.displayName, isUltimate: e.isUltimate ?? false })
  }
  return map
}

function makeSynergyLookup(
  results: Record<string, SynergyPartner[]>,
): SynergyLookup {
  return {
    getHighWinrateCombinations: (base: string, _pool: string[]) =>
      results[base] ?? [],
    getAllOPCombinations: () => [],
    getAllTrapCombinations: () => [],
    getAllHeroSynergies: () => [],
    getAllHeroTrapSynergies: () => [],
    getAllHeroAbilitySynergiesUnfiltered: () => [],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeBestPickSuggestions', () => {
  it('returns empty when no selected abilities', () => {
    const result = computeBestPickSuggestions(
      [],
      [makeSlot({ name: 'fireball' })],
      makeDetailsMap([{ name: 'fireball', displayName: 'Fireball' }]),
      makeSynergyLookup({}),
    )
    expect(result).toEqual([])
  })

  it('returns empty when pool is empty', () => {
    const result = computeBestPickSuggestions(
      [makeSlot({ name: 'blink' })],
      [],
      makeDetailsMap([{ name: 'blink', displayName: 'Blink' }]),
      makeSynergyLookup({}),
    )
    expect(result).toEqual([])
  })

  it('returns empty when no synergies found', () => {
    const result = computeBestPickSuggestions(
      [makeSlot({ name: 'blink' })],
      [makeSlot({ name: 'fireball' }), makeSlot({ name: 'frost_nova' })],
      makeDetailsMap([
        { name: 'blink', displayName: 'Blink' },
        { name: 'fireball', displayName: 'Fireball' },
        { name: 'frost_nova', displayName: 'Frost Nova' },
      ]),
      makeSynergyLookup({ blink: [] }),
    )
    expect(result).toEqual([])
  })

  it('returns top 3 sorted by synergy winrate for 1 picked spell', () => {
    const poolSlots = [
      makeSlot({ name: 'fireball', hero_order: 1, ability_order: 1 }),
      makeSlot({ name: 'frost_nova', hero_order: 2, ability_order: 1 }),
      makeSlot({ name: 'shackles', hero_order: 3, ability_order: 1 }),
      makeSlot({ name: 'stun', hero_order: 4, ability_order: 1 }),
    ]

    const synergies: Record<string, SynergyPartner[]> = {
      blink: [
        { partnerDisplayName: 'Stun', partnerInternalName: 'stun', synergyWinrate: 0.65 },
        { partnerDisplayName: 'Fireball', partnerInternalName: 'fireball', synergyWinrate: 0.60 },
        { partnerDisplayName: 'Frost Nova', partnerInternalName: 'frost_nova', synergyWinrate: 0.55 },
        { partnerDisplayName: 'Shackles', partnerInternalName: 'shackles', synergyWinrate: 0.52 },
      ],
    }

    const result = computeBestPickSuggestions(
      [makeSlot({ name: 'blink' })],
      poolSlots,
      makeDetailsMap([
        { name: 'blink', displayName: 'Blink' },
        { name: 'fireball', displayName: 'Fireball' },
        { name: 'frost_nova', displayName: 'Frost Nova' },
        { name: 'shackles', displayName: 'Shackles' },
        { name: 'stun', displayName: 'Stun' },
      ]),
      makeSynergyLookup(synergies),
    )

    expect(result).toHaveLength(3)
    expect(result[0].abilityName).toBe('stun')
    expect(result[0].synergyWinrate).toBe(0.65)
    expect(result[0].synergizesWithDisplayName).toBe('Blink')
    expect(result[1].abilityName).toBe('fireball')
    expect(result[2].abilityName).toBe('frost_nova')
  })

  it('merges synergies from 2 picked spells and deduplicates keeping highest WR', () => {
    const poolSlots = [
      makeSlot({ name: 'fireball', hero_order: 1, ability_order: 1 }),
      makeSlot({ name: 'frost_nova', hero_order: 2, ability_order: 1 }),
      makeSlot({ name: 'stun', hero_order: 3, ability_order: 1 }),
    ]

    const synergies: Record<string, SynergyPartner[]> = {
      blink: [
        { partnerDisplayName: 'Fireball', partnerInternalName: 'fireball', synergyWinrate: 0.60 },
        { partnerDisplayName: 'Stun', partnerInternalName: 'stun', synergyWinrate: 0.55 },
      ],
      hex: [
        { partnerDisplayName: 'Fireball', partnerInternalName: 'fireball', synergyWinrate: 0.70 }, // higher WR
        { partnerDisplayName: 'Frost Nova', partnerInternalName: 'frost_nova', synergyWinrate: 0.58 },
      ],
    }

    const result = computeBestPickSuggestions(
      [makeSlot({ name: 'blink' }), makeSlot({ name: 'hex' })],
      poolSlots,
      makeDetailsMap([
        { name: 'blink', displayName: 'Blink' },
        { name: 'hex', displayName: 'Hex' },
        { name: 'fireball', displayName: 'Fireball' },
        { name: 'frost_nova', displayName: 'Frost Nova' },
        { name: 'stun', displayName: 'Stun' },
      ]),
      makeSynergyLookup(synergies),
    )

    expect(result).toHaveLength(3)

    // Fireball should have winrate from hex (0.70) since it's higher
    expect(result[0].abilityName).toBe('fireball')
    expect(result[0].synergyWinrate).toBe(0.70)
    expect(result[0].synergizesWithDisplayName).toBe('Hex')

    // Frost Nova from hex
    expect(result[1].abilityName).toBe('frost_nova')
    expect(result[1].synergyWinrate).toBe(0.58)

    // Stun from blink
    expect(result[2].abilityName).toBe('stun')
    expect(result[2].synergyWinrate).toBe(0.55)
  })

  it('returns fewer than 3 when pool has limited synergies', () => {
    const poolSlots = [
      makeSlot({ name: 'fireball', hero_order: 1, ability_order: 1 }),
    ]

    const synergies: Record<string, SynergyPartner[]> = {
      blink: [
        { partnerDisplayName: 'Fireball', partnerInternalName: 'fireball', synergyWinrate: 0.60 },
      ],
    }

    const result = computeBestPickSuggestions(
      [makeSlot({ name: 'blink' })],
      poolSlots,
      makeDetailsMap([
        { name: 'blink', displayName: 'Blink' },
        { name: 'fireball', displayName: 'Fireball' },
      ]),
      makeSynergyLookup(synergies),
    )

    expect(result).toHaveLength(1)
    expect(result[0].abilityName).toBe('fireball')
  })

  it('does not suggest abilities that are already picked', () => {
    const poolSlots = [
      makeSlot({ name: 'fireball', hero_order: 1, ability_order: 1 }),
      makeSlot({ name: 'stun', hero_order: 2, ability_order: 1 }),
    ]

    const synergies: Record<string, SynergyPartner[]> = {
      blink: [
        // hex is in selectedAbilities AND returned as a synergy partner — should be excluded
        { partnerDisplayName: 'Hex', partnerInternalName: 'hex', synergyWinrate: 0.80 },
        { partnerDisplayName: 'Fireball', partnerInternalName: 'fireball', synergyWinrate: 0.60 },
        { partnerDisplayName: 'Stun', partnerInternalName: 'stun', synergyWinrate: 0.55 },
      ],
    }

    const result = computeBestPickSuggestions(
      [makeSlot({ name: 'blink' }), makeSlot({ name: 'hex' })],
      poolSlots,
      makeDetailsMap([
        { name: 'blink', displayName: 'Blink' },
        { name: 'hex', displayName: 'Hex' },
        { name: 'fireball', displayName: 'Fireball' },
        { name: 'stun', displayName: 'Stun' },
      ]),
      makeSynergyLookup(synergies),
    )

    // hex should NOT appear in suggestions since it's a picked ability
    expect(result.every((s) => s.abilityName !== 'hex')).toBe(true)
    expect(result).toHaveLength(2)
    expect(result[0].abilityName).toBe('fireball')
    expect(result[1].abilityName).toBe('stun')
  })

  it('includes coord and display info from pool slots', () => {
    const coord = { x: 100, y: 200, width: 50, height: 50, hero_order: 3 }
    const poolSlots = [
      makeSlot({ name: 'fireball', hero_order: 3, ability_order: 2, coord }),
    ]

    const synergies: Record<string, SynergyPartner[]> = {
      blink: [
        { partnerDisplayName: 'Fireball', partnerInternalName: 'fireball', synergyWinrate: 0.60 },
      ],
    }

    const result = computeBestPickSuggestions(
      [makeSlot({ name: 'blink' })],
      poolSlots,
      makeDetailsMap([
        { name: 'blink', displayName: 'Blink' },
        { name: 'fireball', displayName: 'Fireball' },
      ]),
      makeSynergyLookup(synergies),
    )

    expect(result[0].coord).toEqual(coord)
    expect(result[0].heroOrder).toBe(3)
    expect(result[0].abilityOrder).toBe(2)
    expect(result[0].abilityDisplayName).toBe('Fireball')
  })
})
