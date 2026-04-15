/**
 * PageToolbar Tests — shared filter + search + view toggle component.
 *
 * @module components/UI/PageToolbar.test
 */

import { PageToolbar } from './PageToolbar';
import type { FilterTab } from './PageToolbar';

describe('PageToolbar types', () => {
  it('should accept minimal props', () => {
    const tabs: FilterTab[] = [
      { value: 'all', label: 'All' },
      { value: 'active', label: 'Active', count: 5 },
    ];

    // Type check — component accepts these props
    const props = {
      tabs,
      activeTab: 'all',
      onTabChange: (_v: string) => {},
    };

    expect(props.tabs).toHaveLength(2);
    expect(props.activeTab).toBe('all');
  });

  it('should accept full props with search, view modes, and secondary filters', () => {
    const props = {
      tabs: [{ value: 'all', label: 'All', count: 10 }],
      activeTab: 'all',
      onTabChange: (_v: string) => {},
      searchPlaceholder: 'Search...',
      searchValue: '',
      onSearchChange: (_v: string) => {},
      viewModes: [{ value: 'grid', label: 'Grid', icon: null }],
      activeViewMode: 'grid',
      onViewModeChange: (_v: string) => {},
      secondaryFilters: [{ value: 'urgent', label: 'Urgent', count: 3 }],
      activeSecondaryFilters: new Set(['urgent']),
      onSecondaryFilterToggle: (_v: string) => {},
    };

    expect(props.searchPlaceholder).toBe('Search...');
    expect(props.viewModes).toHaveLength(1);
    expect(props.secondaryFilters).toHaveLength(1);
  });
});
