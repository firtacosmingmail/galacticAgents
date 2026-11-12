import type { PanelData } from '@galactic/protocol';

export function TablePanel({ table }: { table: NonNullable<PanelData['table']> }) {
  return (
    <div className="dash-scroll">
      <table className="dash-table">
        <thead>
          <tr>
            {table.columns.map((c, i) => (
              <th key={i} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, i) => (
                <td key={i}>{cell === null ? '—' : String(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
