There is one excel file attached to show the ABAP Function Module linked to the Process Area.
Similarly another excel to link the BW plan seq and Bex Queries linked to the Process area.
Another excel which is Business Process Master List which is the high level PS process Level,2,3

Based on this process area and associated ABAP and BW objects.

I want to create an interactive dashboard, which will contain all the processes as an interactive Tiles under a tab "PS Process". 

When i click on that individual process tile, then it will show the list of custom Technical objects starting with "Z" or "Y" 
from  SAP ABAP and BW components in SAP MS1/122 environment from packages "ZPS_PROJ_EXEC" , "Z_PROF_SERVICES" and "ZCPM".

For ABAP Objects, show the list of Objects below hierarchy tree map (Function module -> associated/calling Function module/Class -> Class -> associated Method to the class.
For BW objects,  show the list of Objects with below hierarchy tree map  (Planning sequence -> Planning function -> ABAP class call or Fox formulae linked to it.

Also present a dependency and process flow map of the ABAP and BW objects for each process and how the process integrates with other process in an interactive way.
Which can be easily drill down or can be understood for any beginner level analyst.

Also create a separate tab for "Custom Objects" where it needs to list down all custom objects from ABAP FM, BW planning Seq, BW Query, BW planning function, Custom Filters along with category and object created date and Author and linked to the process name.

Add feature to filter for each column which can take input as wild char "** while searching.
Also having a possibility to export all custom object to excel interface/export.

Also feature to connect to SAP MS1 system and refresh the repository of the custom objects real time, when click on "Refresh" Button Under the "Custom Objects" tab.








