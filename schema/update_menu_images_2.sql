-- Update images from Update.zip (was elephant placeholder / missing).
BEGIN;

UPDATE menu_items SET image_url = '/uploads/Drinks/Anna.jpg' WHERE name_en = 'Anna';
UPDATE menu_items SET image_url = '/uploads/Drinks/Grand Maison.jpg' WHERE name_en = 'Grand Maison';
UPDATE menu_items SET image_url = '/uploads/Drinks/Torrebruna.jpg' WHERE name_en = 'Torrebruna';
UPDATE menu_items SET image_url = '/uploads/Drinks/Outstation Vineyards.jpg' WHERE name_en = 'Outstation Vineyards';
UPDATE menu_items SET image_url = '/uploads/Drinks/Poggio Alto.jpg' WHERE name_en = 'Poggio Alto';
UPDATE menu_items SET image_url = '/uploads/Drinks/Thomas Goss.webp' WHERE name_en = 'Thomas Goss';
UPDATE menu_items SET image_url = '/uploads/Drinks/Penfolds Max_s.jpg' WHERE name_en = 'Penfolds Max''s';
UPDATE menu_items SET image_url = '/uploads/Drinks/Monte Zovo.jpg' WHERE name_en = 'Monte Zovo';
UPDATE menu_items SET image_url = '/uploads/Drinks/Chateau Haut-Beyssac.jpg' WHERE name_en = 'Chateau Haut-Beyssac';
UPDATE menu_items SET image_url = '/uploads/Drinks/Chardonnay.jpg' WHERE name_en = 'Chardonnay';
UPDATE menu_items SET image_url = '/uploads/Foods/Basil Fried Rice with Glass Noodle and Minced Pork.jpg' WHERE name_en = 'Basil Fried Rice with Glass Noodle and Minced Pork';
UPDATE menu_items SET image_url = '/uploads/Foods/Basil Fried Rice with Glass Noodles.jpg' WHERE name_en = 'Basil Fried Rice with Glass Noodles';

-- OK? COMMIT;  wrong? ROLLBACK;
COMMIT;
