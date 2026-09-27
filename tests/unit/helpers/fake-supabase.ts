/**
 * Minimal in-memory stand-in for `@supabase/supabase-js`'s query builder.
 *
 * Only the surface the Worker actually uses is implemented:
 * from().select().eq().gt().lt().or().order().limit().maybeSingle(),
 * from().update()....select(), and from().insert(). Enough to exercise the
 * guarded seller writes (edit / mark sold / cancel), the live-listing browse
 * filter and the keyset cursor without touching a real database.
 *
 * NOT modelled: column projection. `select('a,b')` returns whole rows, so tests
 * that care which columns a route asks for assert on `selectColumns()` instead.
 */

export type FilterOp = 'eq' | 'is' | 'lte' | 'lt' | 'neq' | 'or' | 'gt' | 'in' | 'like';

export interface RecordedFilter {
  op: FilterOp;
  column: string;
  value: any;
}

export interface FakeQueryResult {
  data: any;
  error: any;
  count?: number;
}

export interface RecordedOperation {
  table: string;
  op: 'select' | 'update' | 'insert';
  filters: RecordedFilter[];
  payload?: any;
  /** The column list passed to select(), when one was given. */
  columns?: string;
}

export interface FakeSupabaseOptions {
  /**
   * Runs immediately before an UPDATE is matched against the table, so a test
   * can simulate another writer landing between our read and our write.
   */
  beforeUpdate?: (context: { table: string; payload: any; filters: RecordedFilter[]; attempt: number }) => void;
  /** Force an error result from the next matching operation. */
  errorOn?: (context: { table: string; op: 'select' | 'update' | 'insert' }) => any | null;
  /**
   * Models a PostgREST `like` that silently matches nothing rather than
   * erroring - the one failure mode of the image backfill's indexed filter that
   * would otherwise be indistinguishable from "there is no work left".
   */
  likeMatchesNothing?: boolean;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Money columns and the PostgREST text round-trip
// ---------------------------------------------------------------------------

/**
 * The money columns on `auctions`. These were `double precision` on the live
 * database until migration 004; see below for why that matters to `eq`.
 */
export const MONEY_COLUMNS = new Set(['price', 'current_price', 'starting_price', 'winning_bid']);

/**
 * WHY THIS EXISTS.
 *
 * Comparing JS numbers in memory - which is all this fake used to do - cannot
 * catch the bug that shipped: `.eq('current_price', <value read off the row>)`
 * as an optimistic lock over a `double precision` column. In memory the read
 * value and the stored value are the same double, so `===` always held and all
 * 269 tests passed while the bug was live in production.
 *
 * A real `.eq()` does not compare doubles in memory. It goes:
 *
 *   float8 column bits
 *     -> Postgres renders them to decimal text for the JSON response
 *     -> JS parses that text into a double
 *     -> postgrest-js renders the double back to decimal text in the query
 *        string (`current_price=eq.150.1`)
 *     -> Postgres parses that decimal literal and compares it to the column
 *
 * Every arrow is a decimal/binary conversion. For a value with no exact binary
 * representation - which is every pence value, 150.10 among them - whether the
 * original bits come back out the far end is not something the application
 * controls: it depends on the server's float output precision setting
 * (`extra_float_digits`), on the driver's number formatting, and on whether the
 * value needs all 17 significant digits to round-trip.
 *
 * So the fake does not try to reproduce one particular server's configuration.
 * It enforces the GUARANTEE instead: a money `eq` matches only when the value
 * the column holds is exactly the decimal the client put in the query string.
 * That is true for every exactly-representable value (whole pounds, .25, .5,
 * .75) and false for the pence values the old guard could not be trusted on.
 *
 * This is deliberately stricter than any single Postgres configuration. A guard
 * that has to be correct under all of them should be held to that bar, and the
 * strictness is what makes the pence test able to fail on the old code.
 */

/** The decimal text postgrest-js puts in the query string for a filter value. */
function postgrestFilterText(value: number): string {
  return String(value);
}

/**
 * The exact decimal value of a binary double - what a float8 column really
 * holds, as opposed to the shortest decimal that happens to parse back to it.
 * 150.1 is stored as 150.09999999999999431566...; 150 is stored as 150.
 *
 * Trailing zeros are trimmed so an exactly-representable value renders
 * identically to its shortest form and compares equal.
 */
function exactDecimalOfDouble(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }

  const fixed = value.toFixed(20);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/**
 * `=` against a money column, modelled as the text round-trip above rather than
 * as a JS `===`.
 */
function moneyEqMatches(stored: unknown, filterText: string): boolean {
  const storedNumber = Number(stored);
  if (stored === null || stored === undefined || !Number.isFinite(storedNumber)) {
    return false;
  }

  return exactDecimalOfDouble(storedNumber) === filterText;
}

/**
 * Postgres `=` never matches NULL - that is exactly why the bid path needs
 * `.is('current_price', null)` for the first-bid case, so the fake has to
 * reproduce it or the test would pass for the wrong reason.
 */
/** Splits a PostgREST `or=` expression on commas that are not inside `and(...)` or quotes. */
function splitTopLevel(expression: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';

  for (const char of expression) {
    if (char === '"') {
      quoted = !quoted;
    } else if (!quoted) {
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
      } else if (char === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
    }
    current += char;
  }

  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
}

/**
 * Evaluates one node of a PostgREST filter expression: `col.op.value`, or a
 * nested `and(...)` / `or(...)` group. Only the operators the app actually
 * emits are implemented.
 */
function evaluateExpression(row: any, expression: string): boolean {
  const trimmed = expression.trim();

  if (trimmed.startsWith('and(') && trimmed.endsWith(')')) {
    return splitTopLevel(trimmed.slice(4, -1)).every((part) => evaluateExpression(row, part));
  }

  if (trimmed.startsWith('or(') && trimmed.endsWith(')')) {
    return splitTopLevel(trimmed.slice(3, -1)).some((part) => evaluateExpression(row, part));
  }

  const firstDot = trimmed.indexOf('.');
  const secondDot = trimmed.indexOf('.', firstDot + 1);
  if (firstDot < 0 || secondDot < 0) {
    throw new Error(`fake-supabase: cannot parse filter expression "${expression}"`);
  }

  const column = trimmed.slice(0, firstDot);
  const op = trimmed.slice(firstDot + 1, secondDot);
  let raw = trimmed.slice(secondDot + 1);

  const isQuoted = raw.startsWith('"') && raw.endsWith('"');
  if (isQuoted) {
    raw = raw.slice(1, -1);
  }

  const actual = row[column];
  const numeric = !isQuoted && raw !== '' && Number.isFinite(Number(raw)) && Number.isFinite(Number(actual));
  const left: any = numeric ? Number(actual) : String(actual);
  const right: any = numeric ? Number(raw) : raw;

  // `raw` here IS the text from the query string, so the money round-trip is
  // modelled directly: does the column's exact value equal that literal?
  // Ordering operators are left alone - float comparison preserves the order of
  // distinct 2dp decimals, so only `=` is at risk.
  if (op === 'eq' && numeric && MONEY_COLUMNS.has(column)) {
    return moneyEqMatches(actual, raw);
  }

  switch (op) {
    case 'eq':
      return left === right;
    case 'neq':
      return left !== right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    default:
      throw new Error(`fake-supabase: unsupported operator "${op}"`);
  }
}

function matchesFilter(row: any, filter: RecordedFilter): boolean {
  const actual = row[filter.column];

  if (filter.op === 'or') {
    return splitTopLevel(String(filter.value)).some((part) => evaluateExpression(row, part));
  }

  if (filter.op === 'eq') {
    if (actual === null || actual === undefined || filter.value === null || filter.value === undefined) {
      return false;
    }

    // A money column does NOT get a JS `===`. postgrest-js renders the filter
    // value to decimal text and Postgres compares that literal against what the
    // column holds, so an inexact float fails here the way it can in Postgres.
    if (MONEY_COLUMNS.has(filter.column) && typeof filter.value === 'number') {
      return moneyEqMatches(actual, postgrestFilterText(filter.value));
    }

    return actual === filter.value;
  }

  // Postgres `<>` is also NULL-blind: a NULL column never satisfies it.
  if (filter.op === 'neq') {
    if (actual === null || actual === undefined) {
      return false;
    }
    return actual !== filter.value;
  }

  if (filter.op === 'is') {
    if (filter.value === null) {
      return actual === null || actual === undefined;
    }
    return actual === filter.value;
  }

  // Postgres `>` is NULL-blind too, which is what lets the pending-reset scan
  // use `reset_token_expires > now` as its only predicate: rows with no reset
  // in flight hold NULL and are excluded without a second filter.
  if (filter.op === 'gt') {
    if (actual === null || actual === undefined) {
      return false;
    }

    // Numeric when both sides are numbers (`reset_token_expires`,
    // `image_count`), text ordering otherwise. The image backfill pages with
    // `.gt('id', <last id seen>)` over text ids, and coercing those through
    // Number() would make every comparison NaN and silently return nothing.
    const numeric = Number.isFinite(Number(actual)) && Number.isFinite(Number(filter.value));
    return numeric ? Number(actual) > Number(filter.value) : String(actual) > String(filter.value);
  }

  // PostgREST `like`. Only `%` is translated, which is all this codebase emits.
  if (filter.op === 'like') {
    if (actual === null || actual === undefined) {
      return false;
    }

    const pattern = String(filter.value)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, '[\\s\\S]*');

    return new RegExp(`^${pattern}$`).test(String(actual));
  }

  if (filter.op === 'in') {
    return Array.isArray(filter.value) && filter.value.includes(actual);
  }

  // Postgres `<` is NULL-blind, like `>` above.
  if (filter.op === 'lt') {
    if (actual === null || actual === undefined) {
      return false;
    }
    const numeric = Number.isFinite(Number(actual)) && Number.isFinite(Number(filter.value));
    return numeric ? Number(actual) < Number(filter.value) : String(actual) < String(filter.value);
  }

  return Number(actual) <= Number(filter.value);
}

/**
 * PostgREST's JSON-operator select with an alias - `alias:column->>0` (text) or
 * `alias:column->0` (json) - evaluated the way Postgres would: element N of a jsonb array, or
 * NULL.
 *
 * A select that uses one is also PROJECTED to exactly the listed columns, the way PostgREST
 * returns it, so a test can prove the route never saw the whole `image_urls` array. Selects
 * without an alias still return whole rows, as before.
 */
const JSON_ALIAS_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*):([A-Za-z_][A-Za-z0-9_]*)->>?(\d+)$/;

function applyJsonAliases(row: any, columns: string | undefined): any {
  if (!row || !columns) {
    return row;
  }
  const entries = columns.split(',').map((entry) => entry.trim());
  if (!entries.some((entry) => JSON_ALIAS_PATTERN.test(entry))) {
    return row;
  }

  const projected: Record<string, any> = {};
  for (const entry of entries) {
    const match = JSON_ALIAS_PATTERN.exec(entry);
    if (match) {
      const [, alias, column, index] = match;
      const source = row[column];
      const value = Array.isArray(source) ? source[Number(index)] : undefined;
      projected[alias] = value === undefined ? null : value;
    } else if (entry in row) {
      projected[entry] = row[entry];
    }
  }
  return projected;
}

export class FakeSupabase {
  readonly tables: Record<string, any[]>;
  readonly operations: RecordedOperation[] = [];
  updateAttempts = 0;

  constructor(tables: Record<string, any[]>, private options: FakeSupabaseOptions = {}) {
    this.tables = clone(tables);
  }

  from(table: string) {
    return new FakeQuery(this, table, this.options);
  }

  rows(table: string): any[] {
    return this.tables[table] ?? [];
  }

  /** Column lists passed to SELECTs on a table, newest call last. */
  selectColumns(table: string): (string | undefined)[] {
    return this.operations
      .filter((operation) => operation.table === table && operation.op === 'select')
      .map((operation) => operation.columns);
  }

  /** Every filter applied to UPDATEs on a table, newest call last. */
  updateFilters(table: string): RecordedFilter[][] {
    return this.operations
      .filter((operation) => operation.table === table && operation.op === 'update')
      .map((operation) => operation.filters);
  }
}

class FakeQuery {
  private op: 'select' | 'update' | 'insert' = 'select';
  private payload: any = undefined;
  private filters: RecordedFilter[] = [];
  private returning = false;
  private single = false;
  private columns: string | undefined;
  private head = false;
  private orderBy: { column: string; ascending: boolean }[] = [];
  private rowLimit: number | null = null;

  constructor(private db: FakeSupabase, private table: string, private options: FakeSupabaseOptions) {}

  select(columns?: string, options?: any) {
    this.columns = columns;
    this.head = Boolean(options?.head);
    if (this.op === 'update' || this.op === 'insert') {
      this.returning = true;
    } else {
      this.op = 'select';
      this.returning = true;
    }
    return this;
  }


  update(payload: any) {
    this.op = 'update';
    this.payload = payload;
    return this;
  }

  insert(rows: any[]) {
    this.op = 'insert';
    this.payload = rows;
    return this;
  }

  eq(column: string, value: any) {
    this.filters.push({ op: 'eq', column, value });
    return this;
  }

  neq(column: string, value: any) {
    this.filters.push({ op: 'neq', column, value });
    return this;
  }

  /** PostgREST `or=` - the expression is parsed, not just recorded. */
  or(expression: string) {
    this.filters.push({ op: 'or', column: '', value: expression });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderBy.push({ column, ascending: options?.ascending !== false });
    return this;
  }

  limit(count: number) {
    this.rowLimit = count;
    return this;
  }

  is(column: string, value: any) {
    this.filters.push({ op: 'is', column, value });
    return this;
  }

  gt(column: string, value: any) {
    this.filters.push({ op: 'gt', column, value });
    return this;
  }

  lt(column: string, value: any) {
    this.filters.push({ op: 'lt', column, value });
    return this;
  }

  like(column: string, pattern: string) {
    // A pattern no column value can hold, so the filter matches nothing without
    // reporting an error. See `likeMatchesNothing`.
    const value = this.options.likeMatchesNothing ? ' matches nothing ' : pattern;
    this.filters.push({ op: 'like', column, value });
    return this;
  }

  in(column: string, values: any[]) {
    this.filters.push({ op: 'in', column, value: values });
    return this;
  }

  lte(column: string, value: any) {
    this.filters.push({ op: 'lte', column, value });
    return this;
  }

  maybeSingle() {
    this.single = true;
    return this;
  }

  /**
   * Typed as a real PromiseLike rather than `then(onFulfilled?: any)`, so that
   * `await db.from(...).select(...)` type-checks in a test the way it does in
   * the Worker (where the client is untyped and this never came up).
   */
  then<TResult1 = FakeQueryResult, TResult2 = never>(
    onFulfilled?: ((value: FakeQueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onFulfilled, onRejected);
  }

  private async run(): Promise<FakeQueryResult> {
    const rows = this.db.tables[this.table] ?? (this.db.tables[this.table] = []);

    this.db.operations.push({
      table: this.table,
      op: this.op,
      filters: [...this.filters],
      payload: this.payload,
      columns: this.columns,
    });

    const forcedError = this.options.errorOn?.({ table: this.table, op: this.op });
    if (forcedError) {
      return { data: null, error: forcedError };
    }

    if (this.op === 'insert') {
      for (const row of this.payload ?? []) {
        rows.push(clone(row));
      }
      return { data: this.returning ? clone(this.payload) : null, error: null };
    }

    if (this.op === 'update') {
      this.db.updateAttempts += 1;
      this.options.beforeUpdate?.({
        table: this.table,
        payload: this.payload,
        filters: [...this.filters],
        attempt: this.db.updateAttempts,
      });

      const matched = rows.filter((row) => this.filters.every((filter) => matchesFilter(row, filter)));
      for (const row of matched) {
        Object.assign(row, clone(this.payload));
      }

      return { data: this.returning ? clone(matched) : null, error: null };
    }

    const matched = rows.filter((row) => this.filters.every((filter) => matchesFilter(row, filter)));

    if (this.single) {
      return { data: matched.length > 0 ? applyJsonAliases(clone(matched[0]), this.columns) : null, error: null };
    }

    const ordered = [...matched];
    // Applied right-to-left so the first .order() call is the primary sort key.
    for (const { column, ascending } of [...this.orderBy].reverse()) {
      ordered.sort((a, b) => {
        const left = a[column];
        const right = b[column];
        const numeric = Number.isFinite(Number(left)) && Number.isFinite(Number(right));
        const comparison = numeric
          ? Number(left) - Number(right)
          : String(left).localeCompare(String(right));
        return ascending ? comparison : -comparison;
      });
    }

    const limited = this.rowLimit === null ? ordered : ordered.slice(0, this.rowLimit);

    // PostgREST counts the whole match, before LIMIT; `head: true` returns the
    // count with no rows at all.
    return {
      data: this.head ? null : clone(limited).map((row: any) => applyJsonAliases(row, this.columns)),
      error: null,
      count: matched.length,
    };
  }
}

export function createFakeSupabase(tables: Record<string, any[]>, options: FakeSupabaseOptions = {}) {
  return new FakeSupabase(tables, options);
}
