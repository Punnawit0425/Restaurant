-- Fix leftover menu images (name_en differed from file name). Keyed by id.
BEGIN;

UPDATE menu_items SET image_url = '/uploads/Foods/Crying Tiger (Grilled Beef RibeyeBrisket).jpg' WHERE id IN (338);
UPDATE menu_items SET image_url = '/uploads/Foods/Sour Curry (Kaeng Som).jpg' WHERE id IN (297,298,299);
UPDATE menu_items SET image_url = '/uploads/Foods/Spicy Mixed Seafood-Meat Salad.jpg' WHERE id IN (325);
UPDATE menu_items SET image_url = '/uploads/Foods/Stir-Fried Chili & Salt on Rice.jpg' WHERE id IN (224,225,226,227,228);
UPDATE menu_items SET image_url = '/uploads/Foods/Stir-Fried with Fresh Chili on Rice.jpg' WHERE id IN (242,243,244,245);
UPDATE menu_items SET image_url = '/uploads/Foods/Stir-Fried with Garlic and Pepper on Rice.jpg' WHERE id IN (217,218,219);
UPDATE menu_items SET image_url = '/uploads/Foods/Stir-Fried with Oyster Sauce on Rice.jpg' WHERE id IN (213,214,215,216);
UPDATE menu_items SET image_url = '/uploads/Foods/Stir-Fried with Chili Paste on Rice.jpg' WHERE id IN (233,234,235,236);
UPDATE menu_items SET image_url = '/uploads/Foods/Stir-Fried with Curry Powder on Rice.jpg' WHERE id IN (229,230,231,232);
UPDATE menu_items SET image_url = '/uploads/Foods/Stir-Fried with Fish Sauce on Rice.jpg' WHERE id IN (220,221,222,223);
UPDATE menu_items SET image_url = '/uploads/Drinks/crispy.jpg' WHERE id IN (156,177);
UPDATE menu_items SET image_url = '/uploads/Drinks/Erdinger Dunkle.jpg' WHERE id IN (172);
UPDATE menu_items SET image_url = '/uploads/Drinks/red horse.jpg' WHERE id IN (167);
UPDATE menu_items SET image_url = '/uploads/Drinks/tapper.jpg' WHERE id IN (168);
UPDATE menu_items SET image_url = '/uploads/Foods/Lay_s Nori Seaweed.jpg' WHERE id IN (207);
UPDATE menu_items SET image_url = '/uploads/Foods/Lay_s Rock Extra BBQ.jpg' WHERE id IN (206);
UPDATE menu_items SET image_url = '/uploads/Foods/Lay_s Rock Original.jpg' WHERE id IN (208);

-- Manual picks (Corona had two files; kaphrao has no dedicated fried-rice photo)
UPDATE menu_items SET image_url = '/uploads/Drinks/Corona Extra (1).jpg' WHERE id IN (166);
UPDATE menu_items SET image_url = '/uploads/Foods/Basil Fried (Pad Kra Pao).jpg' WHERE id IN (249,250,251,252,253);

-- Check remaining rows without an /uploads image:
-- SELECT id, category, name, name_en, image_url FROM menu_items
--   WHERE image_url IS NULL OR image_url NOT LIKE '/uploads/%' ORDER BY category, name_en;

-- OK? run COMMIT;   wrong? ROLLBACK;
COMMIT;
