import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatPaise, type Paise } from '@/lib/money';
import type { AgingReport } from '@/lib/receivablesAging';

/** Semantic colours matching the design tokens. */
const BUCKET_COLORS: Record<string, string> = {
  current: '#3d5aa8',
  days_1_30: '#d97706',
  days_31_60: '#e0444a',
  days_61_90: '#b8333a',
  days_91_plus: '#7f1d1d',
};

export interface AgingChartProps {
  report: AgingReport;
  height?: number;
}

/**
 * Receivables aging bar chart.
 *
 * Values are converted from paise to rupees only for the axis/tooltip display;
 * the underlying arithmetic stays in paise.
 */
export function AgingChart({ report, height = 260 }: AgingChartProps) {
  const data = useMemo(
    () =>
      report.buckets.map((bucket) => ({
        name: bucket.label,
        bucket: bucket.bucket,
        // Rupees as a number purely for chart geometry. Display uses formatPaise.
        rupees: Number(bucket.amountPaise / 100n),
        amountPaise: bucket.amountPaise,
        invoiceCount: bucket.invoiceCount,
      })),
    [report.buckets],
  );

  const hasData = report.totalOutstandingPaise > 0n;

  if (!hasData) {
    return (
      <div className="flex h-[220px] items-center justify-center px-6 text-center">
        <p className="text-sm text-muted">
          No outstanding balances yet. Aging appears once invoices are issued.
        </p>
      </div>
    );
  }

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 12, fill: '#6b7280' }}
            axisLine={{ stroke: '#e5e7eb' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 12, fill: '#6b7280' }}
            axisLine={false}
            tickLine={false}
            width={64}
            tickFormatter={(value: number) =>
              value >= 100000 ? `${(value / 100000).toFixed(1)}L` : value.toLocaleString('en-IN')
            }
          />
          <Tooltip
            cursor={{ fill: 'rgba(61, 90, 168, 0.06)' }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0]!.payload as { name: string; amountPaise: Paise; invoiceCount: number };
              return (
                <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
                  <p className="font-medium text-ink">{point.name}</p>
                  <p className="mt-1 tabular text-ink">{formatPaise(point.amountPaise)}</p>
                  <p className="text-muted">
                    {point.invoiceCount} invoice{point.invoiceCount === 1 ? '' : 's'}
                  </p>
                </div>
              );
            }}
          />
          <Bar dataKey="rupees" radius={[4, 4, 0, 0]} maxBarSize={64}>
            {data.map((entry) => (
              <Cell key={entry.bucket} fill={BUCKET_COLORS[entry.bucket] ?? '#3d5aa8'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
