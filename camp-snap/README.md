# Camp Snap photo viewer

A small web app for triaging photos from a Camp Snap camera:
**https://peterhauck.github.io/camp-snap/**

## Using it on a phone

1. Plug the Camp Snap into your phone with its USB‑C cable and turn it on
   (it shows up as a USB drive in the Files app).
2. Open the app. If your album is empty — or you tap the "camera not
   connected" banner / import button — it prompts you to connect and import.
3. Tap **Import camera folder…** and pick the Camp Snap drive's `DCIM`
   folder (or **Choose photos…** to pick individual shots). Photos are
   copied into the app's own library, so you can unplug and browse anywhere.

Then:

- **Tap a photo** to view it full screen; swipe left/right to flip through.
  Each photo has **Delete** and **Save** buttons.
- **Select** (or long-press a photo) to multi-select, then save the batch to
  your camera roll (via the share sheet) or delete the batch.
- **Deleted** tab is a trash folder: restore a photo back to the album,
  delete it forever, or **Purge all**. Purged photos won't be re-imported
  next time you plug the camera in.

Tip: use the share/"Add to Home Screen" option to install it like an app.

## On a computer (desktop Chrome or Edge)

**Open camera folder** uses the File System Access API with write access, so
the app also tidies the camera itself: deleting a photo moves the file into a
`DELETED` folder on the camera, restoring moves it back, and purging removes
it from the camera for good.

## Notes

- Photos live in the browser's IndexedDB storage on the device — nothing is
  uploaded anywhere.
- On phones the app can't write to the USB drive, so deletes only affect the
  app's library; the files stay on the camera until you clear them from a
  computer (or the camera's own controls).
