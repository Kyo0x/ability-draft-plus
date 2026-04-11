import type { ScanResult, BestPickSuggestion } from '@shared/types'
import type { SynergyLookup } from './types'

const MAX_SUGGESTIONS = 3

/**
 * Compute the best 3 abilities from the draft pool that synergize with the user's
 * currently picked spell(s). For each picked ability, queries synergy partners in the
 * pool, merges results, deduplicates (keeping highest synergy winrate), sorts descending,
 * and returns the top 3.
 *
 * Returns an empty array when there are no selected abilities or no synergies found.
 */
export function computeBestPickSuggestions(
  selectedAbilities: ScanResult[],
  poolSlots: ScanResult[],
  abilityDetailsMap: Map<string, { displayName: string; isUltimate: boolean }>,
  synergyLookup: SynergyLookup,
): BestPickSuggestion[] {
  const pickedNames = selectedAbilities
    .map((s) => s.name)
    .filter((n): n is string => n !== null)

  if (pickedNames.length === 0) return []

  const poolNames = poolSlots
    .map((s) => s.name)
    .filter((n): n is string => n !== null)

  if (poolNames.length === 0) return []

  // Build a coord lookup: ability name → first matching pool slot
  const poolSlotByName = new Map<string, ScanResult>()
  for (const slot of poolSlots) {
    if (slot.name && !poolSlotByName.has(slot.name)) {
      poolSlotByName.set(slot.name, slot)
    }
  }

  // For each picked ability, gather synergy partners from the pool
  // Key: partner ability name → { best synergy winrate, which picked spell it pairs with }
  const bestByPartner = new Map<
    string,
    { synergyWinrate: number; synergizesWithName: string }
  >()

  for (const pickedName of pickedNames) {
    const combos = synergyLookup.getHighWinrateCombinations(pickedName, poolNames)
    for (const combo of combos) {
      // Skip if this partner is also a picked ability (don't suggest what's already picked)
      if (pickedNames.includes(combo.partnerInternalName)) continue

      const existing = bestByPartner.get(combo.partnerInternalName)
      if (!existing || combo.synergyWinrate > existing.synergyWinrate) {
        bestByPartner.set(combo.partnerInternalName, {
          synergyWinrate: combo.synergyWinrate,
          synergizesWithName: pickedName,
        })
      }
    }
  }

  // Sort by synergy winrate descending, take top 3
  const sorted = Array.from(bestByPartner.entries())
    .sort((a, b) => b[1].synergyWinrate - a[1].synergyWinrate)
    .slice(0, MAX_SUGGESTIONS)

  return sorted.map(([partnerName, { synergyWinrate, synergizesWithName }]) => {
    const slot = poolSlotByName.get(partnerName)!
    const details = abilityDetailsMap.get(partnerName)
    const pickedDetails = abilityDetailsMap.get(synergizesWithName)

    return {
      abilityName: partnerName,
      abilityDisplayName: details?.displayName ?? partnerName,
      synergyWinrate,
      synergizesWithDisplayName: pickedDetails?.displayName ?? synergizesWithName,
      coord: slot.coord,
      heroOrder: slot.hero_order,
      abilityOrder: slot.ability_order,
      isUltimate: details?.isUltimate ?? slot.is_ultimate,
    }
  })
}
