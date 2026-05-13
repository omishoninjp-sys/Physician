/**
 * 中小企業向け基本勘定科目セット
 * 建立 client 時自動插入
 */
export const DEFAULT_ACCOUNTS = [
  // 資產
  { code: '1001', name: '現金', category: 'asset', tax: 0, sort: 10 },
  { code: '1002', name: '普通預金', category: 'asset', tax: 0, sort: 20 },
  { code: '1003', name: '売掛金', category: 'asset', tax: 0, sort: 30 },
  { code: '1004', name: '前払費用', category: 'asset', tax: 0, sort: 40 },
  { code: '1005', name: '仮払消費税', category: 'asset', tax: 0, sort: 50 },

  // 負債
  { code: '2001', name: '買掛金', category: 'liability', tax: 0, sort: 110 },
  { code: '2002', name: '未払金', category: 'liability', tax: 0, sort: 120 },
  { code: '2003', name: '預り金', category: 'liability', tax: 0, sort: 130 },
  { code: '2004', name: '仮受消費税', category: 'liability', tax: 0, sort: 140 },

  // 純資產
  { code: '3001', name: '資本金', category: 'equity', tax: 0, sort: 210 },
  { code: '3002', name: '利益剰余金', category: 'equity', tax: 0, sort: 220 },

  // 收益
  { code: '4001', name: '売上高', category: 'revenue', tax: 10, sort: 310 },

  // 費用
  { code: '5101', name: '仕入高', category: 'expense', tax: 10, sort: 410 },
  { code: '5201', name: '給料手当', category: 'expense', tax: 0, sort: 420 },
  { code: '5202', name: '法定福利費', category: 'expense', tax: 0, sort: 430 },
  { code: '5301', name: '旅費交通費', category: 'expense', tax: 10, sort: 510 },
  { code: '5302', name: '通信費', category: 'expense', tax: 10, sort: 520 },
  { code: '5303', name: '水道光熱費', category: 'expense', tax: 10, sort: 530 },
  { code: '5304', name: '消耗品費', category: 'expense', tax: 10, sort: 540 },
  { code: '5305', name: '接待交際費', category: 'expense', tax: 10, sort: 550 },
  { code: '5306', name: '会議費', category: 'expense', tax: 10, sort: 560 },
  { code: '5307', name: '広告宣伝費', category: 'expense', tax: 10, sort: 570 },
  { code: '5308', name: '支払手数料', category: 'expense', tax: 10, sort: 580 },
  { code: '5309', name: '地代家賃', category: 'expense', tax: 10, sort: 590 },
  { code: '5310', name: '修繕費', category: 'expense', tax: 10, sort: 600 },
  { code: '5311', name: '租税公課', category: 'expense', tax: 0, sort: 610 },
  { code: '5312', name: '雑費', category: 'expense', tax: 10, sort: 620 },
];
