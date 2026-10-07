// Role rules (spec sec 7.1, 7.2): the pure parts. The database-backed parts are in db.test.ts.
import { describe, expect, it } from 'vitest';
import { adminsFromEnv, allowedActions, can, effectiveRole, leavesNoOwner, ROLES, type Action, type Role } from '../src/access.js';

describe('sec 7.2 role table', () => {
  const table: [Action, Role[]][] = [
    ['VIEW', ['OWNER', 'PRIMARY_CARER', 'FAMILY', 'VIEWER']],
    ['LOG_CARE', ['OWNER', 'PRIMARY_CARER', 'FAMILY']],
    ['ADD_MEDIA', ['OWNER', 'PRIMARY_CARER', 'FAMILY']],
    ['DROP_DOCUMENTS', ['OWNER', 'PRIMARY_CARER', 'FAMILY']],
    ['PROPOSE_RECORDS', ['OWNER', 'PRIMARY_CARER', 'FAMILY']],
    ['CONFIRM_RECORDS', ['OWNER', 'PRIMARY_CARER']],
    ['MANAGE_CARE', ['OWNER', 'PRIMARY_CARER']],
    ['SEE_COSTS', ['OWNER', 'PRIMARY_CARER']],
    ['SEE_COST_TOTALS', ['OWNER', 'PRIMARY_CARER', 'FAMILY']],
    ['SEE_DOCUMENTS', ['OWNER', 'PRIMARY_CARER', 'FAMILY']],
    ['VET_PACK', ['OWNER', 'PRIMARY_CARER', 'FAMILY']],
    ['EDIT_PROFILE', ['OWNER', 'PRIMARY_CARER']],
    ['MANAGE_ROLES', ['OWNER']],
  ];
  for (const [action, allowed] of table) {
    it(`${action}: ${allowed.join(', ')}`, () => {
      for (const r of ROLES) expect(can(r, action)).toBe(allowed.includes(r));
    });
  }
  it('a Viewer can only look', () => {
    expect(allowedActions('VIEWER')).toEqual(['VIEW']);
  });
  it('no role on an animal = Family member (household default, sec 7.1)', () => {
    expect(effectiveRole(undefined)).toBe('FAMILY');
    expect(effectiveRole(null)).toBe('FAMILY');
    expect(effectiveRole('VIEWER')).toBe('VIEWER');
  });
});

describe('last-Owner rule', () => {
  const two = [{ member_name: 'Alex', role: 'OWNER' as const }, { member_name: 'Sam', role: 'FAMILY' as const }];
  it('the only Owner cannot leave or step down', () => {
    expect(leavesNoOwner(two, 'Alex', null)).toBe(true);
    expect(leavesNoOwner(two, 'Alex', 'PRIMARY_CARER')).toBe(true);
    expect(leavesNoOwner(two, 'Alex', 'VIEWER')).toBe(true);
  });
  it('fine when another Owner remains or is being added', () => {
    expect(leavesNoOwner([...two, { member_name: 'Kim', role: 'OWNER' }], 'Alex', null)).toBe(false);
    expect(leavesNoOwner(two, 'Sam', 'OWNER')).toBe(false);
    expect(leavesNoOwner(two, 'Alex', 'OWNER')).toBe(false);
    expect(leavesNoOwner(two, 'Sam', null)).toBe(false);
  });
});

describe('PETOPIA_ADMINS', () => {
  it('is a trimmed comma list; empty means nobody', () => {
    expect(adminsFromEnv(' Alex , Sam,,')).toEqual(['Alex', 'Sam']);
    expect(adminsFromEnv('')).toEqual([]);
  });
});
