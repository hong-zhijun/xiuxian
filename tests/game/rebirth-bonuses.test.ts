import { GAME_CONFIG_CONTENT } from '@xiuxian/game-config';
import { describe, expect, it } from 'vitest';
import { discipleCombatPower, partyCombatPower } from '../../apps/server/src/modules/game/realms';
import { resourceRates, settleEconomy } from '../../apps/server/src/modules/game/settle';

describe('转生永久加成与现有系统共用规则', () => {
  it('永久战力在装备、天赋和成仙之后应用，同一队伍按成员归属分别计算', () => {
    const base = discipleCombatPower('tribulation', 3, 80, 70, 60, 'none', 2000, 1);
    expect(discipleCombatPower('tribulation', 3, 80, 70, 60, 'none', 2000, 1, 500)).toBe(Math.floor(base * 1.05));
    const members = [
      { realmId: 'goldenCore', stage: 1, attack: 50, defense: 50, speed: 50, permanentPowerBp: 500 },
      { realmId: 'goldenCore', stage: 1, attack: 50, defense: 50, speed: 50, permanentPowerBp: 1500 },
    ];
    expect(partyCombatPower(members)).toBe(members.reduce((sum, m) => sum + discipleCombatPower(m.realmId,m.stage,m.attack,m.defense,m.speed,undefined,0,0,m.permanentPowerBp),0));
  });
  it('称号2%与首次转生10%相加，在线展示和离线入账一致', () => {
    const config = GAME_CONFIG_CONTENT;
    const rate = resourceRates(config, [], { spiritualArray: 1 }, 1200).get('spiritualEnergy');
    const settled = settleEconomy({ config, productionBonusBp: 1200, lastSettledAt: 0, now: 3_600_000,
      resources: [{ resourceId: 'spiritualEnergy', balance: 0, remainder: 0 }], disciples: [], buildingLevels: { spiritualArray: 1 } }, () => 1);
    expect(rate).toBe(313_600);
    expect(settled.resources[0]?.balance).toBe(rate);
  });
});
