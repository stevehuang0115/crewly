/**
 * Knowledge Category Filter
 *
 * Sidebar filter for selecting document categories.
 * Shows "All" plus each available category with counts when available.
 *
 * @module components/Knowledge/KnowledgeCategoryFilter
 */

interface KnowledgeCategoryFilterProps {
  /** Available categories */
  categories: string[];
  /** Currently selected category (empty string = all) */
  selectedCategory: string;
  /** Callback when category selection changes */
  onCategoryChange: (category: string) => void;
}

/**
 * Renders a vertical list of category filter buttons.
 *
 * @param props - Component props
 * @returns Category filter JSX
 */
export function KnowledgeCategoryFilter({
  categories,
  selectedCategory,
  onCategoryChange,
}: KnowledgeCategoryFilterProps) {
  return (
    <div className="space-y-1" role="listbox" aria-label="Filter by category">
      <button
        role="option"
        aria-selected={selectedCategory === ''}
        onClick={() => onCategoryChange('')}
        className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
          selectedCategory === ''
            ? 'bg-primary/20 text-primary font-medium'
            : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
        }`}
      >
        All
      </button>
      {categories.map((cat) => (
        <button
          key={cat}
          role="option"
          aria-selected={selectedCategory === cat}
          onClick={() => onCategoryChange(cat)}
          className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
            selectedCategory === cat
              ? 'bg-primary/20 text-primary font-medium'
              : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
          }`}
        >
          {cat}
        </button>
      ))}
    </div>
  );
}
