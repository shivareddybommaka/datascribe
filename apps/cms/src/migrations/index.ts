import * as migration_20261023_142531_initial from './20261023_142531_initial';

export const migrations = [
  {
    up: migration_20261023_142531_initial.up,
    down: migration_20261023_142531_initial.down,
    name: '20261023_142531_initial'
  },
];
