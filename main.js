const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const ExcelJS = require('exceljs');
const { start } = require('repl');
const puppeteer = require('puppeteer-core');
const puppeteerExtra = require('puppeteer-extra');

const delay = (time) => new Promise(resolve => setTimeout(resolve, time));


const sanitizeFileName = (url) => {
    return url.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.xlsx';  // Replace all non-alphanumeric characters with underscores
};

const outputDir = path.join(__dirname, 'output');
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir); // Create the output directory if it doesn't exist
}
// Function to get latitude and longitude based on the address
async function getLatLongFromAddress(address) {
    const { default: fetch } = await import('node-fetch'); // Dynamically import node-fetch
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`;

    try {
        // Fetch the geocoding data
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; MyGeocoderApp/1.0; +http://mywebsite.com)'
            }
        });
        const data = await response.json();

        if (data && data.length > 0) {
            const { lat, lon } = data[0];
            console.log(`Latitude: ${lat}, Longitude: ${lon}`);
            return { latitude: lat, longitude: lon };
        } else {
            console.log('No results found for the address.');
            return { latitude: 'N/A', longitude: 'N/A' };
        }
    } catch (error) {
        console.error('Error fetching data:', error);
        return { latitude: 'N/A', longitude: 'N/A' };
    }
}


const startUrls = [
    "https://www.immoweb.be/en/search/other/for-sale?countries=BE&priceType=SALE_PRICE&page=1&orderBy=relevance",
    // Add your URLs here
];

(async () => {
  const browser = await puppeteerExtra.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: null,
});

    const page = await browser.newPage();

    // Set viewport to be maximized
    const { width, height } = await page.evaluate(() => {
        return {
            width: window.screen.width,
            height: window.screen.height
        };
    });

    await page.setViewport({ width, height });

    // Custom delay function

    for (const startUrl of startUrls) {

        await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: 0 });

        async function getTotalPages() {
            try {
                // Extract the pagination elements
                const totalPages = await page.evaluate(() => {
                    // Select all pagination items
                    const paginationItems = Array.from(document.querySelectorAll('ul.pagination li.pagination__item'));

                    // Filter out items that contain the skip buttons or next button
                    const pageNumbers = paginationItems.map(item => {
                        const spanElement = item.querySelector('span.button__label');
                        if (spanElement) {
                            return parseInt(spanElement.textContent.trim(), 10);
                        }
                        return null;
                    }).filter(page => !isNaN(page)); // Filter out null values

                    // Get the highest number from the pagination
                    return Math.max(...pageNumbers);
                });

                return totalPages || 1; // Default to 1 if no pages are found
            } catch (error) {
                console.error('Error getting total pages:', error);
                return 1;  // Default to 1 page if there's an error
            }
        }
        const totalPages = await getTotalPages();
        console.log("Total pages to scrape:", totalPages);



        let data = [];
        let counter = 0;
        let pageNumber = 1;

        // Determine transactionType from the start URL
        let transactionType = startUrl.includes('sale') || startUrl.includes('vendre') ? 'sale' : startUrl.includes('rent') ? 'rent' : 'unknown';

        // Determine propertyType from the start URL
        const propertyTypes = [
            'house',
            'apartment',
            'office',
            'garage',
            'business',
            'industrial',
            'other',
            'maison',
            'houses',
            'apartments',
            'land',
            'tenement',
            'Maison',
            'Appartement',
            'Maison et appartement',
            'Projet neuf - Maisons',
            'Projet neuf - Appartements',
            'Projet neuf',
            'Garage',
            'Bureau',
            'Commerce',
            'Industrie',
            'Terrain',
            'Immeuble de rapport',
            'Autre'
        ];
        let propertyType = propertyTypes.find(type => 
            startUrl.toLowerCase().includes(type.toLowerCase())
        ) || 'unknown';

        console.log(`Transaction Type: ${transactionType}`);
        console.log(`Property Type: ${propertyType}`);


        async function scrapePage(url) {
            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                console.log("Processing URL:", url);

                const propertyLinks = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('div[id^="lazy-loading-observer-wrapper-"] a.card__title-link')).map(link => link.href);
                });

                console.log("Total links on page", pageNumber, ":", propertyLinks.length);

                for (let link of propertyLinks) {
                    await scrapeProperty(link);
                    await delay(2000); // Wait for 2 seconds after scraping each property
                }

                if (pageNumber < totalPages) {
                    pageNumber++;
                    const nextPage = new URL(startUrl);
                    nextPage.searchParams.set('page', pageNumber);
                    await scrapePage(nextPage.href);
                }
            } catch (error) {
                console.error('Error navigating to page:', error);
            }
        }

        let count = 1
        async function scrapeProperty(url) {
            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

                const propertyData = await page.evaluate(() => {
                    const name = document.querySelector('meta[property="og:title"]').content;
                    const descriptionElement = document.querySelector('#classified-description-content-text');
                    const description = descriptionElement ? descriptionElement.innerText.trim() : null;
                    const price = document.querySelector('p.classified__price span.sr-only').innerText;
                    const characteristics = Array.from(document.querySelectorAll('div.text-block__body .overview__text')).map(el => el.innerText);

                    let area = null;

                    // Search for area in the characteristics text
                    for (let char of characteristics) {
                        const areaMatch = char.match(/(\d+)\s*m²/);
                        if (areaMatch) {
                            area = areaMatch[1] + " m²";
                            break;
                        }
                    }

                    const addressButton = document.querySelector('.classified__information--address-map-button');
                    let address = '';
                    if (addressButton) {
                        const addressLines = addressButton.querySelectorAll('.classified__information--address-row');
                        address = Array.from(addressLines).map(el => el.innerText.trim()).join(', ');
                    }
        
                    // If the address is still empty, scrape it from the new structure
                    if (!address) {
                        const addressDiv = document.querySelector('.classified__information--address p span.classified__information--address-row');
                        if (addressDiv) {
                            address = addressDiv.innerText.trim();
                        }
                    }

                    const properties = {};
                    // Extract key-value pairs from the accordion sections
                    const accordionSections = document.querySelectorAll('.accordion__content');
                    accordionSections.forEach(section => {
                        const rows = section.querySelectorAll('.classified-table__row');
                        rows.forEach(row => {
                            const keyElement = row.querySelector('.classified-table__header');
                            const valueElement = row.querySelector('.classified-table__data');
                            if (keyElement && valueElement) {
                                const key = keyElement.innerText.trim();
                                const value = valueElement.innerText.trim();
                                properties[key] = value;
                            }
                        });
                    });     
                    return {
                        name,
                        description,
                        price,
                        address,
                        area: area ? area : null, // Ensure area is null if not found
                        characteristics: characteristics.join(', '),
                        properties // All key-value pairs from the accordion sections
                    };
                });
                // Add propertyType and transactionType
                propertyData.propertyType = propertyType;
                propertyData.transactionType = transactionType;
                Address = propertyData.address


                const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(Address)}`;
                await page.goto(searchUrl, { waitUntil: 'networkidle2' });
                await delay(5000); // Allow time for Google Maps to load
        

                let latitude = 'N/A', longitude = 'N/A';
                const currentUrl = page.url();
                const urlMatch = currentUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
                if (urlMatch) {
                    propertyData.latitude = urlMatch[1];
                    propertyData.longitude = urlMatch[2];
                    console.log(`Latitude: ${latitude}, Longitude: ${longitude}`);
                } else {
                    console.log('Google Maps could not find latitude and longitude. Falling back to Nominatim.');
                    const fallbackCoordinates = await getLatLongFromAddress(Address);
                   propertyData.latitude = fallbackCoordinates.latitude;
                    propertyData.longitude = fallbackCoordinates.longitude;
                }



                propertyData.propertyUrl = url;
                data.push(propertyData);
                console.log(count)
                count++
                counter++;

                console.log("Scraped data:", propertyData);
            } catch (error) {
                console.error('Error scraping property:', error);
            }
        }

        await scrapePage(startUrl);

        const sanitizedFilename = sanitizeFileName(startUrl);
        const filepath = path.join(outputDir, sanitizedFilename);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Scraped Data');

        worksheet.columns = [
            { header: 'Property URL', key: 'propertyUrl', width: 30 },
            { header: 'Name', key: 'name', width: 30 },
            { header: 'Description', key: 'description', width: 30 },
            { header: 'Price', key: 'price', width: 15 },
            { header: 'Address', key: 'address', width: 30 },
            { header: 'Latitude', key: 'latitude', width: 15 },
            { header: 'Longitude', key: 'longitude', width: 15 },
            { header: 'Property Type', key: 'propertyType', width: 15 },
            { header: 'Transaction Type', key: 'transactionType', width: 15 },
            { header: 'Area', key: 'area', width: 15 },
            { header: 'Characteristics', key: 'characteristics', width: 30 },
            { header: 'Properties', key: 'properties', width: 30 }

        ];

data.forEach(item => {
            worksheet.addRow({
                ...item,
                properties: JSON.stringify(item.properties) // Convert properties object to JSON string
            });
        });

        await workbook.xlsx.writeFile(filepath);
        console.log(`Saved scraped data to ${filepath}`);
        console.log(`Scraped ${counter} items from ${startUrl}`);
    }

    await browser.close();
})();
