// Initial data used the very first time the server runs (when data.json does
// not exist yet). After that, the live state lives in backend/data.json.
export const SEED = {
  orders: [],
  // Baked-in copy of the menu, used as the offline fallback. The server
  // re-syncs from PostgreSQL (backend/menu-db.js) on startup and whenever
  // POST /api/menu/refresh is called.
  menu: [
    { id: "d1", name: "ทอดน้ำปลาราดข้าว", price: 50, category: "อาหารจานเดียว", theme: 'day', emoji: "🐟", desc: '', options: [{ name: "หมู", price: 50 }, { name: "ไก่", price: 50 }, { name: "หมูกรอบ", price: 60 }, { name: "ทะเล", price: 70 }], available: true },
    { id: "d2", name: "ผัดน้ำมันหอยราดข้าว", price: 50, category: "อาหารจานเดียว", theme: 'day', emoji: "🐚", desc: '', options: [{ name: "หมู", price: 50 }, { name: "ไก่", price: 50 }, { name: "หมูกรอบ", price: 60 }, { name: "ทะเล", price: 70 }], available: true },
    { id: "d3", name: "ผัดกระเทียมพริกไทยราดข้าว", price: 50, category: "อาหารจานเดียว", theme: 'day', emoji: "🍳", desc: '', options: [{ name: "หมู", price: 50 }, { name: "ไก่", price: 50 }, { name: "หมูกรอบ", price: 60 }, { name: "ทะเล", price: 70 }], available: true },
    { id: "d4", name: "คั่วพริกเกลือราดข้าว", price: 50, category: "อาหารจานเดียว", theme: 'day', emoji: "🍚", desc: '', options: [{ name: "หมู", price: 50 }, { name: "ไก่", price: 50 }, { name: "หมูกรอบ", price: 60 }, { name: "ทะเล", price: 70 }], available: true },
    { id: "d5", name: "ผัดผงกะหรี่ราดข้าว", price: 50, category: "อาหารจานเดียว", theme: 'day', emoji: "🍳", desc: '', options: [{ name: "หมู", price: 50 }, { name: "ไก่", price: 50 }, { name: "หมูกรอบ", price: 60 }, { name: "ทะเล", price: 70 }], available: true },
    { id: "d6", name: "ผัดน้ำพริกเผาราดข้าว", price: 50, category: "อาหารจานเดียว", theme: 'day', emoji: "🍳", desc: '', options: [{ name: "หมู", price: 50 }, { name: "ไก่", price: 50 }, { name: "หมูกรอบ", price: 60 }, { name: "ทะเล", price: 70 }], available: true },
    { id: "d7", name: "ข้าวผัด", price: 50, category: "อาหารจานเดียว", theme: 'day', emoji: "🍚", desc: '', options: [{ name: "หมู", price: 50 }, { name: "ไก่", price: 50 }, { name: "ทะเล", price: 70 }], available: true },
    { id: "d8", name: "ผัดพริกราดข้าว", price: 50, category: "อาหารจานเดียว", theme: 'day', emoji: "🍳", desc: '', options: [{ name: "หมู", price: 50 }, { name: "ไก่", price: 50 }, { name: "หมูกรอบ", price: 60 }, { name: "ทะเล", price: 70 }], available: true },
    { id: "d9", name: "ผัดเผ็ดราดข้าว หมู", price: 50, category: "อาหารจานเดียว", theme: 'day', emoji: "🐷", desc: '', options: [], available: true },
    { id: "d10", name: "ผัดผักคะน้าราดข้าว", price: 50, category: "อาหารจานเดียว", theme: 'day', emoji: "🍳", desc: '', options: [{ name: "หมู", price: 50 }, { name: "ไก่", price: 50 }, { name: "หมูกรอบ", price: 60 }, { name: "ทะเล", price: 70 }, { name: "ปลาเค็ม", price: 70 }], available: true },
    { id: "d11", name: "ผัดกะเพราราดข้าว", price: 50, category: "อาหารจานเดียว", theme: 'day', emoji: "🌿", desc: '', options: [{ name: "หมู", price: 50 }, { name: "ไก่", price: 50 }, { name: "หมูกรอบ", price: 70 }], available: true },
    { id: "d12", name: "ข้าวผัดกะเพราไข่เยี่ยวม้า", price: 50, category: "อาหารจานเดียว", theme: 'day', emoji: "🍳", desc: '', options: [{ name: "หมู", price: 50 }, { name: "ไก่", price: 50 }, { name: "หมูกรอบ", price: 70 }], available: true },
    { id: "d13", name: "ข้าวผัดกะเพราวุ้นเส้น หมูสับ", price: 60, category: "อาหารจานเดียว", theme: 'day', emoji: "🐷", desc: '', options: [], available: true },
    { id: "d14", name: "ผัดพริกเนื้อราดข้าว", price: 70, category: "อาหารจานเดียว", theme: 'day', emoji: "🥩", desc: '', options: [], available: true },
    { id: "d15", name: "ผัดกะเพราเนื้อราดข้าว", price: 70, category: "อาหารจานเดียว", theme: 'day', emoji: "🥩", desc: '', options: [], available: true },
    { id: "d16", name: "ผัดพริกเผาเนื้อราดข้าว", price: 70, category: "อาหารจานเดียว", theme: 'day', emoji: "🥩", desc: '', options: [], available: true },
    { id: "d17", name: "ผัดเผ็ดเนื้อราดข้าว", price: 70, category: "อาหารจานเดียว", theme: 'day', emoji: "🥩", desc: '', options: [], available: true },
    { id: "d18", name: "คั่วพริกเกลือเนื้อราดข้าว", price: 70, category: "อาหารจานเดียว", theme: 'day', emoji: "🥩", desc: '', options: [], available: true },
    { id: "d19", name: "พริกแกงปลาดุกทอดราดข้าว", price: 70, category: "อาหารจานเดียว", theme: 'day', emoji: "🐟", desc: '', options: [], available: true },
    { id: "d20", name: "พริกแกงปลาดุกราดข้าว", price: 70, category: "อาหารจานเดียว", theme: 'day', emoji: "🐟", desc: '', options: [], available: true },
    { id: "d21", name: "กะเพราปลาดุกราดข้าว", price: 70, category: "อาหารจานเดียว", theme: 'day', emoji: "🐟", desc: '', options: [], available: true },
    { id: "d22", name: "ต้มโคล้งปลาดุกทอดราดข้าว", price: 70, category: "อาหารจานเดียว", theme: 'day', emoji: "🐟", desc: '', options: [], available: true },
    { id: "d23", name: "ผัดเผ็ดกบราดข้าว", price: 80, category: "อาหารจานเดียว", theme: 'day', emoji: "🐸", desc: '', options: [], available: true },
    { id: "d24", name: "ผัดเผ็ดหมูป่าราดข้าว", price: 80, category: "อาหารจานเดียว", theme: 'day', emoji: "🐗", desc: '', options: [], available: true },
    { id: "d25", name: "ผัดซีอิ๊ว", price: 50, category: "อาหารจานเดียว", theme: 'day', emoji: "🍜", desc: '', options: [{ name: "หมู", price: 50 }, { name: "ไก่", price: 50 }, { name: "ทะเล", price: 70 }], available: true },
    { id: "d26", name: "ราดหน้า", price: 50, category: "อาหารจานเดียว", theme: 'day', emoji: "🍜", desc: '', options: [{ name: "หมู", price: 50 }, { name: "ไก่", price: 50 }, { name: "ทะเล", price: 70 }], available: true },
    { id: "d27", name: "ต้มข่าไก่", price: 70, category: "กับข้าว", theme: 'day', emoji: "🍗", desc: '', options: [], available: true },
    { id: "d28", name: "ต้มจืดเต้าหู้", price: 70, category: "กับข้าว", theme: 'day', emoji: "🍲", desc: '', options: [{ name: "หมูสับ", price: 70 }, { name: "ไก่สับ", price: 70 }], available: true },
    { id: "d29", name: "ผัดสะตอกุ้ง", price: 80, category: "กับข้าว", theme: 'day', emoji: "🍤", desc: '', options: [], available: true },
    { id: "d30", name: "ผัดเผ็ดปลาดุก", price: 80, category: "กับข้าว", theme: 'day', emoji: "🐟", desc: '', options: [], available: true },
    { id: "d31", name: "ผัดพริกเผาหอยลาย", price: 80, category: "กับข้าว", theme: 'day', emoji: "🐚", desc: '', options: [], available: true },
    { id: "d32", name: "แกงส้ม", price: 80, category: "กับข้าว", theme: 'day', emoji: "🥘", desc: '', options: [{ name: "ปลา", price: 80 }, { name: "หมู", price: 80 }, { name: "กุ้ง", price: 80 }], available: true },
    { id: "d33", name: "ข้าวสวย", price: 20, category: "เพิ่มเติม", theme: 'day', emoji: "🍚", desc: '', options: [], available: true },
    // Beverages (เครื่องดื่ม rows in the menu_items table).
    { id: "bev1", name: "ชาดำเย็น", price: 35, category: "ชา", theme: 'day', emoji: "🍵", desc: '', options: [{ name: "M", price: 35 }, { name: "L", price: 40 }], available: true },
    { id: "bev2", name: "ชาเย็น", price: 35, category: "ชา", theme: 'day', emoji: "🍵", desc: '', options: [{ name: "M", price: 35 }, { name: "L", price: 40 }], available: true },
    { id: "bev3", name: "ชาเขียวลองกรีน", price: 35, category: "ชา", theme: 'day', emoji: "🍵", desc: '', options: [{ name: "M", price: 35 }, { name: "L", price: 40 }], available: true },
    { id: "bev4", name: "ชาเขียวเย็น", price: 35, category: "ชา", theme: 'day', emoji: "🍵", desc: '', options: [{ name: "M", price: 35 }, { name: "L", price: 40 }], available: true },
    { id: "bev5", name: "ชามะนาว", price: 35, category: "ชา", theme: 'day', emoji: "🍵", desc: '', options: [{ name: "M", price: 35 }, { name: "L", price: 40 }], available: true },
    { id: "bev6", name: "โกโก้เย็น", price: 40, category: "โกโก้ นม", theme: 'day', emoji: "🍫", desc: '', options: [{ name: "M", price: 40 }, { name: "L", price: 45 }], available: true },
    { id: "bev7", name: "โกโก้กรีนที", price: 40, category: "โกโก้ นม", theme: 'day', emoji: "🍫", desc: '', options: [{ name: "M", price: 40 }, { name: "L", price: 45 }], available: true },
    { id: "bev8", name: "ชาโคลน", price: 40, category: "โกโก้ นม", theme: 'day', emoji: "🍵", desc: '', options: [{ name: "M", price: 40 }, { name: "L", price: 45 }], available: true },
    { id: "bev9", name: "โกโก้ทีเลิฟ", price: 40, category: "โกโก้ นม", theme: 'day', emoji: "🍫", desc: '', options: [{ name: "M", price: 40 }, { name: "L", price: 45 }], available: true },
    { id: "bev10", name: "นมชมพู", price: 35, category: "โกโก้ นม", theme: 'day', emoji: "🥛", desc: '', options: [{ name: "M", price: 35 }, { name: "L", price: 40 }], available: true },
    { id: "bev11", name: "นมเขียว", price: 35, category: "โกโก้ นม", theme: 'day', emoji: "🥛", desc: '', options: [{ name: "M", price: 35 }, { name: "L", price: 40 }], available: true },
    { id: "bev12", name: "โอวัลตินเย็น", price: 40, category: "โกโก้ นม", theme: 'day', emoji: "🥤", desc: '', options: [{ name: "M", price: 40 }, { name: "L", price: 45 }], available: true },
    { id: "bev13", name: "เอสเปรสโซ่เย็น", price: 35, category: "กาแฟ", theme: 'day', emoji: "☕", desc: '', options: [{ name: "M", price: 35 }, { name: "L", price: 40 }], available: true },
    { id: "bev14", name: "ลาเต้เย็น", price: 35, category: "กาแฟ", theme: 'day', emoji: "☕", desc: '', options: [{ name: "M", price: 35 }, { name: "L", price: 40 }], available: true },
    { id: "bev15", name: "คาปูชิโน่เย็น", price: 35, category: "กาแฟ", theme: 'day', emoji: "☕", desc: '', options: [{ name: "M", price: 35 }, { name: "L", price: 40 }], available: true },
    { id: "bev16", name: "มอคค่าเย็น", price: 40, category: "กาแฟ", theme: 'day', emoji: "☕", desc: '', options: [{ name: "M", price: 40 }, { name: "L", price: 45 }], available: true },
    { id: "bev17", name: "อเมริกาโน่เย็น", price: 35, category: "กาแฟ", theme: 'day', emoji: "☕", desc: '', options: [{ name: "M", price: 35 }, { name: "L", price: 40 }], available: true },
    { id: "bev18", name: "อเมริกาโน่น้ำผึ้งเย็น", price: 40, category: "กาแฟ", theme: 'day', emoji: "☕", desc: '', options: [{ name: "M", price: 40 }, { name: "L", price: 45 }], available: true },
    { id: "bev19", name: "อเมริกาโน่น้ำผึ้ึ้งมะนาว", price: 40, category: "กาแฟ", theme: 'day', emoji: "☕", desc: '', options: [{ name: "M", price: 40 }, { name: "L", price: 45 }], available: true },
    { id: "bev20", name: "น้ำแดงโซดา", price: 30, category: "น้ำผลไม้โซดา", theme: 'day', emoji: "🥤", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev21", name: "น้ำเขียวโซดา", price: 30, category: "น้ำผลไม้โซดา", theme: 'day', emoji: "🥤", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev22", name: "น้ำมะนาวโซดา", price: 30, category: "น้ำผลไม้โซดา", theme: 'day', emoji: "🥤", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev23", name: "น้ำบ๊วยโซดา", price: 30, category: "น้ำผลไม้โซดา", theme: 'day', emoji: "🥤", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev24", name: "น้ำองุ่นโซดา", price: 30, category: "น้ำผลไม้โซดา", theme: 'day', emoji: "🥤", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev25", name: "น้ำน้ำผึ้งโซดา", price: 30, category: "น้ำผลไม้โซดา", theme: 'day', emoji: "🥤", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev26", name: "น้ำลิ้นจี่โซดา", price: 30, category: "น้ำผลไม้โซดา", theme: 'day', emoji: "🥤", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev27", name: "น้ำส้มโซดา", price: 30, category: "น้ำผลไม้โซดา", theme: 'day', emoji: "🥤", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev28", name: "น้ำแคนตาลูปโซดา", price: 30, category: "น้ำผลไม้โซดา", theme: 'day', emoji: "🥤", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev29", name: "น้ำแตงโมโซดา", price: 30, category: "น้ำผลไม้โซดา", theme: 'day', emoji: "🥤", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev30", name: "น้ำมะม่วงโซดา", price: 30, category: "น้ำผลไม้โซดา", theme: 'day', emoji: "🥤", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev31", name: "น้ำแอปเปิ้ลเขียวโซดา", price: 30, category: "น้ำผลไม้โซดา", theme: 'day', emoji: "🥤", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev32", name: "น้ำสตรอเบอร์รี่โซดา", price: 30, category: "น้ำผลไม้โซดา", theme: 'day', emoji: "🥤", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev33", name: "น้ำผึ้งมะนาวโซดา", price: 30, category: "น้ำผลไม้โซดา", theme: 'day', emoji: "🥤", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev34", name: "ชามะนาว", price: 30, category: "ชาผลไม้", theme: 'day', emoji: "🍵", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev35", name: "ชาบ๊วย", price: 30, category: "ชาผลไม้", theme: 'day', emoji: "🍵", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev36", name: "ชาองุ่น", price: 30, category: "ชาผลไม้", theme: 'day', emoji: "🍵", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev37", name: "ชาน้ำผึ้ง", price: 30, category: "ชาผลไม้", theme: 'day', emoji: "🍵", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev38", name: "ชาลิ้นจี่", price: 30, category: "ชาผลไม้", theme: 'day', emoji: "🍵", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev39", name: "ชาแคนตาลูป", price: 30, category: "ชาผลไม้", theme: 'day', emoji: "🍵", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev40", name: "ชาแตงโม", price: 30, category: "ชาผลไม้", theme: 'day', emoji: "🍵", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev41", name: "ชามะม่วง", price: 30, category: "ชาผลไม้", theme: 'day', emoji: "🍵", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev42", name: "ชาแอปเปิ้ลเขียว", price: 30, category: "ชาผลไม้", theme: 'day', emoji: "🍵", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev43", name: "ชาสตรอเบอร์รี่", price: 30, category: "ชาผลไม้", theme: 'day', emoji: "🍵", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev44", name: "ชาน้ำผึ้งมะนาว", price: 30, category: "ชาผลไม้", theme: 'day', emoji: "🍵", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev45", name: "ชาส้ม", price: 30, category: "ชาผลไม้", theme: 'day', emoji: "🍵", desc: '', options: [{ name: "M", price: 30 }, { name: "L", price: 35 }], available: true },
    { id: "bev46", name: "ไข่มุก", price: 5, category: "ท็อปปิ้ง", theme: 'day', emoji: "🧋", desc: '', options: [], available: true },
    { id: "bev47", name: "บุก", price: 5, category: "ท็อปปิ้ง", theme: 'day', emoji: "🍮", desc: '', options: [], available: true },
    { id: "bev48", name: "บุกเฉาก๊วย", price: 5, category: "ท็อปปิ้ง", theme: 'day', emoji: "🍮", desc: '', options: [], available: true },
    { id: "bev49", name: "มุกป๊อปแอปเปิ้ล", price: 5, category: "ท็อปปิ้ง", theme: 'day', emoji: "🧋", desc: '', options: [], available: true },
    { id: "bev50", name: "มุกป๊อปลิ้นจี่", price: 5, category: "ท็อปปิ้ง", theme: 'day', emoji: "🧋", desc: '', options: [], available: true },
    { id: "bev51", name: "มุกป๊อปบลูเบอร์รี่", price: 5, category: "ท็อปปิ้ง", theme: 'day', emoji: "🧋", desc: '', options: [], available: true },
    { id: "bev52", name: "มุกป๊อปสตรอเบอร์รี่", price: 5, category: "ท็อปปิ้ง", theme: 'day', emoji: "🧋", desc: '', options: [], available: true },
    { id: "bev53", name: "เฉาก๊วยชากังราว", price: 30, category: "ของหวาน", theme: 'day', emoji: "🍮", desc: '', options: [], available: true },
    { id: "bev54", name: "เฉาก๊วยนมสด", price: 40, category: "ของหวาน", theme: 'day', emoji: "🍮", desc: '', options: [], available: true },
  ],
  stock: {
    // Day-shift stock (kitchen ingredients / limited daily dishes).
    DST01: { name: 'กุ้งสด (ผัดไทย/ต้มยำ)', count: 30, min: 8, theme: 'day' },
    DST02: { name: 'เนื้อปูก้อน (ข้าวผัดปู)', count: 15, min: 4, theme: 'day' },
    DST03: { name: 'มะม่วงน้ำดอกไม้สุก', count: 12, min: 4, theme: 'day' },
    DST04: { name: 'ไข่ไก่สด', count: 60, min: 15, theme: 'day' },
    // Night-shift stock (bar drinks).
    ST01: { name: 'ค็อกเทล Signature Blue Ocean', count: 24, min: 5, theme: 'night' },
    ST02: { name: 'เบียร์คราฟต์รสพีช', count: 8, min: 10, theme: 'night' },
    ST03: { name: 'วิสกี้พรีเมียม (ช็อต)', count: 45, min: 15, theme: 'night' },
    ST04: { name: 'โซดาเกลือหิมะ', count: 2, min: 12, theme: 'night' }
  },
  // Test accounts for trialling the role split. `role` decides which panel a
  // login lands on ('owner' → back office, 'staff' → shift board); `shop`
  // decides which shift (day/night) a staff account defaults to.
  staff: [
    // `pin` is the 4-digit ไอดีพนักงาน that signs a printed bill or a discount.
    // Hashed on first run like the password (see migrateStaffPasswords) — these
    // starter codes are meant to be replaced from the owner's staff screen.
    { user: 'admin', pass: '1234', pin: '1111', name: 'เจ้าของร้าน', role: 'owner', shop: 'day', position: 'เจ้าของ', dailyWage: 0 },
    { user: 'day', pass: '1234', pin: '2222', name: 'พนักงานกลางวัน', role: 'staff', shop: 'day', position: 'หน้าร้าน', dailyWage: 350 },
    { user: 'night', pass: '1234', pin: '3333', name: 'พนักงานกลางคืน', role: 'staff', shop: 'night', position: 'บาร์', dailyWage: 400 },
    { user: 'cook', pass: '1234', pin: '4444', name: 'แม่ครัว', role: 'staff', shop: 'day', position: 'ครัว', dailyWage: 450 }
  ],
  settings: {
    name: 'ตู้กับข้าวบ้านยาย',
    nameNight: 'เรือนเก่า',
    tables: 9,
    baseUrl: ''
  },
  // Owner-recorded outgoings (rent, ingredients, wages...). Each entry is
  // { id, date: 'YYYY-MM-DD', shop: 'day'|'night', category, amount, note, createdAt }.
  expenses: []
};
